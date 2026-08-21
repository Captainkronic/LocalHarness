#!/usr/bin/env node
/**
 * Does this 3D game actually play?
 *
 * play-test.mjs answers that for a 2D canvas game and cannot answer it here:
 * its frame signature calls getContext('2d'), which returns null on a WebGL
 * canvas, so every check reports 'tainted' and a perfectly good three.js scene
 * grades as broken. This is the 3D sibling.
 *
 * Two differences that matter:
 *
 *   - The page is SERVED, not opened as a file. An ES-module three.js build
 *     cannot load from a file:// origin at all, so a file:// run measures the
 *     module loader rather than the game.
 *   - Movement is read from the game's own state rather than from pixels. A
 *     screenshot diff cannot tell a rolling ball from a rotating camera, and a
 *     WebGL canvas will not hand over its pixels without preserveDrawingBuffer.
 *     The game exposes window.__golf; this reads it.
 *
 *   node scripts/overnight/probe-3d.mjs <workspace-dir> [--page index.html] [--json out.json] [--keep]
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d
}
const WS = resolve(argv[0] ?? '.')
const PAGE = arg('page', 'index.html')
const JSON_OUT = arg('json', null)
const SHOT_DIR = arg('shots', join(WS, '.probe'))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok: Boolean(ok), note: String(note).slice(0, 300) })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `  ${note}` : ''}`)
}
const finish = async (extra = {}) => {
  const failed = results.filter((r) => !r.ok)
  const summary =
    failed.length === 0
      ? `PLAYS — ${results.length}/${results.length} checks passed`
      : `${failed.length} PROBLEM(S): ${failed.map((f) => f.name).join('; ')}`
  console.log(`\n${summary}\n`)
  if (JSON_OUT) {
    await writeFile(JSON_OUT, JSON.stringify({ summary, results, ...extra }, null, 2)).catch(() => {})
  }
  process.exit(failed.length === 0 ? 0 : 1)
}

/* ---- serve the workspace -------------------------------------------- */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav'
}
const served = []
const server = createServer((req, res) => {
  const rel = normalize(decodeURI((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(WS, rel)
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  // Chrome asks every page for a favicon it was never told about. Counting
  // that as a missing asset reports a fault in every game ever written.
  if (rel !== '/favicon.ico') served.push({ url: rel, ok: existsSync(file) })
  if (!existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
const PORT = await new Promise((r) => {
  server.listen(0, '127.0.0.1', () => r(server.address().port))
})
const URL_ = `http://127.0.0.1:${PORT}/${PAGE}`

if (!existsSync(join(WS, PAGE))) {
  check(`${PAGE} exists`, false, `nothing at ${join(WS, PAGE)}`)
  server.close()
  await finish()
}
check(`${PAGE} exists`, true, `${statSync(join(WS, PAGE)).size} bytes`)

/* ---- chrome ---------------------------------------------------------- */

const profile = await mkdtemp(join(tmpdir(), 'lh-probe3d-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=0`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--window-size=1200,900',
    // Software GL: headless has no GPU, and without these three a WebGL context
    // request returns null and the game is blamed for a missing renderer.
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    URL_
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] }
)
// The port is chosen by Chrome and announced on stderr, because a fixed one
// collides with the other probe when two runs overlap.
let devtoolsPort = null
chrome.stderr.on('data', (b) => {
  const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(String(b))
  if (m) devtoolsPort = Number(m[1])
})

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  await sleep(250)
  if (!devtoolsPort) continue
  try {
    const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) {
  chrome.kill()
  server.close()
  check('chrome opened a debugging port', false, 'never came up')
  await finish()
}

const sock = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  sock.onopen = res
  sock.onerror = () => rej(new Error('cdp connect failed'))
})
let nextId = 1
const pending = new Map()
const pageErrors = []
let socketDead = false
sock.onclose = () => {
  socketDead = true
}
sock.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? {})
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
  }
}
const send = (method, params = {}, ms = 10000) =>
  new Promise((res) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      res({})
    }, ms)
    pending.set(id, (r) => {
      clearTimeout(timer)
      res(r)
    })
    sock.send(JSON.stringify({ id, method, params }))
  })

let stalls = 0
const evaluate = async (expr, fallback = null) => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { try { return (${expr}) } catch (e) { return { __err: String(e) } } })()`,
    returnByValue: true,
    awaitPromise: true
  })
  const v = r?.result?.value
  if (v === undefined) {
    stalls += 1
    return fallback
  }
  return v
}

await send('Runtime.enable')
await send('Page.enable')
await send('Page.bringToFront')
await sleep(2500)

let shotN = 0
async function shot(label) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, 15000)
  if (r?.data) {
    await writeFile(join(SHOT_DIR, `probe-${String(++shotN).padStart(2, '0')}-${label}.png`), Buffer.from(r.data, 'base64')).catch(
      () => {}
    )
  }
}
await import('node:fs/promises').then((fs) => fs.mkdir(SHOT_DIR, { recursive: true })).catch(() => {})

/* ---- the checks ------------------------------------------------------ */

console.log(`\nprobe  ${URL_}\n`)

const missing = served.filter((s) => !s.ok).map((s) => s.url)
check('every asset the page asks for exists', missing.length === 0, missing.slice(0, 5).join(', '))

const canvas = await evaluate(`(() => {
  const cs=[...document.querySelectorAll('canvas')]
  if(!cs.length) return {n:0}
  const c=cs.sort((a,b)=>b.width*b.height-a.width*a.height)[0]
  const gl=c.getContext('webgl2')||c.getContext('webgl')||null
  return {n:cs.length,w:c.width,h:c.height,gl:Boolean(gl)}
})()`, { n: 0 })
check('renders a canvas', canvas.n > 0, canvas.n ? `${canvas.w}x${canvas.h}` : 'no <canvas> in the document')
// A context already taken by three.js cannot be re-got, so gl:false here is
// only meaningful when nothing else claimed it — hence it is a note, not a gate.
check('canvas has real size', canvas.w > 100 && canvas.h > 100, `${canvas.w}x${canvas.h}`)

// rAF ticks, counted in the page. Pixel diffing cannot distinguish "nothing is
// animating" from "this frame happens to look the same".
await evaluate(`(() => { window.__ticks=0; const f=window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame=(cb)=>f((t)=>{window.__ticks++;return cb(t)}); return 1 })()`)
await sleep(1500)
const ticks = Number(await evaluate(`window.__ticks|0`, 0))
check('the render loop is running', ticks > 10, `${ticks} frames in 1.5s`)

await shot('open')

const hasHook = await evaluate(`Boolean(window.__golf && typeof window.__golf.state==='function')`, false)
check('exposes the window.__golf test hook', hasHook === true, hasHook ? '' : 'no state() — the rest cannot be measured')

let state0 = null
if (hasHook === true) {
  state0 = await evaluate(`window.__golf.state()`, null)
  const keys = state0 && typeof state0 === 'object' ? Object.keys(state0) : []
  check('state() returns the documented shape', keys.includes('ball') && keys.includes('cup') && keys.includes('strokes'), keys.join(','))

  const dist = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0))
  const d0 = dist(state0?.ball, state0?.cup)

  // Aim straight at the cup and hit it. A putt that leaves the ball no closer
  // is either physics that does nothing or aiming that points somewhere else.
  const canPutt = await evaluate(`typeof window.__golf.putt==='function'`, false)
  check('exposes putt(angleDeg, power)', canPutt === true)
  if (canPutt === true) {
    await evaluate(`(() => {
      const s=window.__golf.state()
      const a=Math.atan2(s.cup.x-s.ball.x, s.cup.z-s.ball.z)*180/Math.PI
      window.__golf.putt(a, 0.55)
      return 1
    })()`)
    await sleep(500)
    const moving = await evaluate(`(() => { const s=window.__golf.state(); return Math.hypot(s.ball.vx||0,s.ball.vz||0) })()`, 0)
    check('the ball moves when you putt', Number(moving) > 0.01, `speed ${Number(moving).toFixed(3)}`)

    const s1 = await evaluate(`window.__golf.state()`, null)
    check('the stroke count went up', (s1?.strokes ?? 0) > (state0?.strokes ?? 0), `${state0?.strokes} -> ${s1?.strokes}`)

    // Rest, within a sane time. A ball that never stops is friction that never
    // applies, and it makes the game unfinishable rather than merely wrong.
    let rested = false
    let sN = s1
    for (let i = 0; i < 30 && !rested; i++) {
      await sleep(500)
      sN = await evaluate(`window.__golf.state()`, sN)
      const sp = Math.hypot(sN?.ball?.vx ?? 0, sN?.ball?.vz ?? 0)
      if (sp < 0.02) rested = true
    }
    check('the ball comes to rest', rested, rested ? '' : 'still moving after 15s')
    await shot('after-putt')

    const d1 = dist(sN?.ball, sN?.cup)
    check('a putt aimed at the cup gets closer to it', d1 < d0 - 0.01, `${d0.toFixed(2)} -> ${d1.toFixed(2)}`)
    check('the ball stayed on the world', Number.isFinite(d1) && d1 < 500, `distance ${d1.toFixed(2)}`)

    // Sink it: full power straight at the cup, up to eight putts.
    let holed = Boolean(sN?.holed)
    for (let i = 0; i < 8 && !holed; i++) {
      await evaluate(`(() => {
        const s=window.__golf.state()
        const d=Math.hypot(s.cup.x-s.ball.x, s.cup.z-s.ball.z)
        const a=Math.atan2(s.cup.x-s.ball.x, s.cup.z-s.ball.z)*180/Math.PI
        window.__golf.putt(a, Math.max(0.12, Math.min(0.9, d/18)))
        return 1
      })()`)
      for (let j = 0; j < 24; j++) {
        await sleep(500)
        const s = await evaluate(`window.__golf.state()`, null)
        holed = Boolean(s?.holed)
        const sp = Math.hypot(s?.ball?.vx ?? 0, s?.ball?.vz ?? 0)
        if (holed || sp < 0.02) break
      }
    }
    check('the hole can actually be holed out', holed, holed ? '' : 'eight putts aimed at the cup, never dropped')
    await shot('holed-or-gave-up')
  }
}

check('no javascript errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | ').slice(0, 240))
check('page stayed responsive', stalls === 0 && !socketDead, socketDead ? 'devtools socket closed mid-probe' : stalls ? `${stalls} evaluates timed out` : '')

sock.close()
chrome.kill()
server.close()
if (!argv.includes('--keep')) {
  await sleep(500)
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
}
await finish({ pageErrors: pageErrors.slice(0, 10), url: URL_ })
