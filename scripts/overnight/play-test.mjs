#!/usr/bin/env node
/**
 * Does this game actually play?
 *
 * Counting for the string "canvas" proves nothing — the first Tetris this
 * produced scored 4/4 on markers before anyone had pressed a key. This drives
 * the real thing: launches headless Chrome with the DevTools protocol open,
 * dispatches genuine key events, and compares what the canvas renders before
 * and after each one. A control that does nothing shows up as an unchanged
 * frame, which is exactly the failure a marker check cannot see.
 *
 *   node scripts/overnight/play-test.mjs <file.html> [--keep]
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILE = process.argv[2]
if (!FILE) {
  console.error('usage: play-test.mjs <file.html>')
  process.exit(1)
}
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const PORT = 9400 + Math.floor(Math.random() * 500)
const profile = await mkdtemp(join(tmpdir(), 'lh-play-'))

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--disable-gpu',
  '--no-first-run',
  '--window-size=1000,900',
  // Headless Chrome treats an unfocused page as occluded and stops servicing
  // requestAnimationFrame, which freezes the game and makes every control look
  // broken. It also stalls captureScreenshot, which is what timed out. These
  // three keep the renderer live.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  `file://${encodeURI(FILE).replace(/#/g, '%23')}`
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Chrome needs a moment before the debugging endpoint answers. */
let wsUrl = null
for (let i = 0; i < 60 && !wsUrl; i++) {
  await sleep(300)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
    if (page) wsUrl = page.webSocketDebuggerUrl
  } catch {
    /* not up yet */
  }
}
if (!wsUrl) {
  chrome.kill()
  console.error('chrome never opened its debugging port')
  process.exit(1)
}

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('cdp connect failed'))
})

let nextId = 1
const pending = new Map()
const consoleErrors = []
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result ?? {})
    pending.delete(msg.id)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description).join(' '))
  }
}
/** Every call is raced against a timeout. Without one, a single CDP command
 *  that never answers hangs the whole test forever — which it did. */
const send = (method, params = {}, ms = 8000) =>
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
    ws.send(JSON.stringify({ id, method, params }))
  })

let shotN = 0
const SHOT_DIR = FILE.replace(/\/[^/]+$/, '')

/**
 * A frame per stage, taken from the CANVAS rather than from the page.
 *
 * Page.captureScreenshot was the wrong tool: after three calls it stopped
 * answering and took the whole DevTools socket with it, so every check after
 * the third stage reported a failure that was really a dead connection. The
 * canvas is what this test is about anyway, and toDataURL comes back over the
 * same Runtime.evaluate channel everything else uses.
 */
async function shot(label) {
  const data = await evaluate(`(() => {
    const cs = [...document.querySelectorAll('canvas')];
    if (!cs.length) return '';
    const c = cs.sort((a,b) => b.width*b.height - a.width*a.height)[0];
    try { return c.toDataURL('image/png'); } catch (e) { return ''; }
  })()`)
  if (typeof data === 'string' && data.startsWith('data:image')) {
    await writeFile(
      `${SHOT_DIR}/play-${String(++shotN).padStart(2, '0')}-${label}.png`,
      Buffer.from(data.split(',')[1], 'base64')
    )
  }
}

ws.onclose = () => { socketDead = true }
await send('Runtime.enable')
await send('Page.enable')
await sleep(1500)

let stalls = 0
let socketDead = false
const evaluate = async (expr, fallback = '') => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  const v = r?.result?.value
  if (v === undefined) {
    // A timed-out evaluate used to return undefined and crash the next line
    // that touched it. Counted instead, and reported: a stalled page is a
    // finding about the GAME, not a reason to lose the run.
    stalls += 1
    return fallback
  }
  return v
}

/** A hash of what the main canvas is showing. Cheap, and enough to answer
 *  "did anything change" without shipping the whole image around. */
const CANVAS_SIG = `(() => {
  const cs = [...document.querySelectorAll('canvas')];
  if (!cs.length) return 'nocanvas';
  const c = cs.sort((a,b) => b.width*b.height - a.width*a.height)[0];
  try {
    const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let h = 0;
    for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0;
    return String(h);
  } catch (e) { return 'tainted'; }
})()`

const TEXT = `document.body.innerText.replace(/\\s+/g,' ').slice(0,400)`

async function key(code, keyName, times = 1) {
  for (let i = 0; i < times; i++) {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        key: keyName,
        code: keyName
      })
    }
    await sleep(160)
  }
  await sleep(500)
}

const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok, note })
  console.log(`  ${ok ? '\x1b[32mok\x1b[0m  ' : '\x1b[31mFAIL\x1b[0m'} ${name}${note ? `  ${note}` : ''}`)
}

console.log(`\n\x1b[1mplay test\x1b[0m  ${FILE.split('/').pop()}\n`)

const hasCanvas = (await evaluate(`document.querySelectorAll('canvas').length`)) > 0
check('renders a canvas', hasCanvas)

await shot('start')
const a = await evaluate(CANVAS_SIG)
check('canvas draws something', a !== 'nocanvas' && a !== 'tainted' && a !== '0', a)

/* Animation: two samples a moment apart must differ, or nothing is falling. */
await sleep(1200)
const b = await evaluate(CANVAS_SIG)
check('the game animates on its own', a !== b, a === b ? 'frame identical after 1.2s' : '')

/* Each control must change the picture. */
const before1 = await evaluate(CANVAS_SIG)
await shot('before-left')
await key(37, 'ArrowLeft', 2)
const afterLeft = await evaluate(CANVAS_SIG)
check('left arrow does something', before1 !== afterLeft)

await shot('after-left')
await key(39, 'ArrowRight', 2)
const afterRight = await evaluate(CANVAS_SIG)
check('right arrow does something', afterLeft !== afterRight)

const beforeRot = await evaluate(CANVAS_SIG)
await shot('before-rotate')
await key(38, 'ArrowUp', 1)
const afterRot = await evaluate(CANVAS_SIG)
check('rotate does something', beforeRot !== afterRot)

/* Scoring: drop a stack of pieces and require a number on screen to move. */
const textBefore = await evaluate(TEXT)
await shot('after-rotate')
await key(32, 'Space', 6)
await sleep(1200)
const textAfter = await evaluate(TEXT)
const nums = (s) => (s.match(/\d+/g) ?? []).join(',')
check('the score or counters move when you play', nums(textBefore) !== nums(textAfter),
  `${nums(textBefore).slice(0, 40)} -> ${nums(textAfter).slice(0, 40)}`)

/* Still alive and still drawing after sustained play. */
await sleep(2500)
const late = await evaluate(CANVAS_SIG)
await sleep(1200)
const later = await evaluate(CANVAS_SIG)
const over = /game over/i.test(await evaluate(TEXT))
check(
  'still running after sustained play',
  late !== later || over,
  late !== later ? '' : over ? 'reached game over' : 'canvas stopped changing'
)

check('no javascript errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | ').slice(0, 120))
check('page stayed responsive', stalls === 0 && !socketDead,
  socketDead ? 'the devtools socket closed mid-test' : stalls ? `${stalls} calls timed out` : '')

await shot('final')

ws.close()
chrome.kill()
// Chrome keeps writing to its profile for a moment after kill(), so a plain
// rmdir races it and throws ENOTEMPTY over a test that already passed.
if (!process.argv.includes('--keep')) {
  await new Promise((r) => setTimeout(r, 500))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

const failed = results.filter((r) => !r.ok)
console.log(
  failed.length === 0
    ? `\n\x1b[32mPLAYS — ${results.length}/${results.length}\x1b[0m\n`
    : `\n\x1b[31m${failed.length} PROBLEM(S)\x1b[0m: ${failed.map((f) => f.name).join('; ')}\n`
)
process.exit(failed.length === 0 ? 0 : 1)
