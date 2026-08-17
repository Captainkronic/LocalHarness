#!/usr/bin/env node
/**
 * Runs the same agentic build at each reasoning effort, one at a time, and
 * reports which settings actually finish.
 *
 * Strictly sequential — the Mac Studio holds one model and renders one request
 * at a time, so overlapping runs would measure contention rather than settings.
 *
 * What it is really testing: on a file-writing task this model drafts the whole
 * artifact INSIDE its reasoning block and then has to write it again as a tool
 * call, so reasoning tokens are duplicated work rather than deliberation. The
 * question is whether turning thinking down or off produces the file faster,
 * and whether the file is any worse for it.
 *
 * Judged on outcome, not on prose: did Galaxy Quest.html appear, how big is it,
 * how long did it take. A run that reasons beautifully and writes nothing has
 * failed.
 *
 *   node scripts/reasoning-battery.mjs [effort...]
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile, stat, unlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SETTINGS = join(homedir(), 'Library/Application Support/localharness/settings.json')
const WORKSPACE = '/Users/adam/Documents/QWEN 38/GameStation'
const SHOTS = '/private/tmp/claude-501/-Applications/ba08a163-5837-4759-90c0-3e8b35e499cf/scratchpad'

const EFFORTS = process.argv.slice(2).length ? process.argv.slice(2) : ['none', 'low', 'medium']
/** Generous: a failing run must be allowed to fail on its own terms, not be
 *  cut off by the harness and then blamed on the setting. */
const PER_RUN_MS = 20 * 60 * 1000

const PROMPT =
  'in the current working directory, make me a single file html game that is a ' +
  'SPACE INVADERS style clone that runs in browser. use Javascript, html, and ' +
  'css to create it. call it Galaxy Quest.'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function gameFiles() {
  try {
    const all = await readdir(WORKSPACE)
    return all.filter((f) => /\.html?$/i.test(f))
  } catch {
    return []
  }
}

async function clearGames() {
  for (const f of await gameFiles()) await unlink(join(WORKSPACE, f)).catch(() => {})
}

async function setEffort(effort) {
  const s = JSON.parse(await readFile(SETTINGS, 'utf8'))
  s.workflowReasoning = { ...(s.workflowReasoning ?? {}), code: effort }
  await writeFile(SETTINGS, JSON.stringify(s, null, 2))
}

const drive = (effort) => `
const el=document.createElement('div');
el.style.cssText='position:fixed;right:8px;bottom:8px;z-index:99999;background:#000c;color:#7fd97f;font:10px/1.35 ui-monospace,monospace;padding:5px 7px;border:1px solid #2a5a3a;border-radius:4px;max-width:290px;max-height:150px;overflow:auto;white-space:pre-wrap;opacity:.82;pointer-events:none';
document.body.appendChild(el);
const t0=Date.now();
const say=(m)=>{el.textContent+=String(Math.round((Date.now()-t0)/1000)).padStart(3)+'s '+m+'\\n';el.scrollTop=el.scrollHeight};
say('battery · thinking=${effort}');
const chat=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Chat');
if(chat){chat.click();await new Promise(r=>setTimeout(r,700))}
const nb=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='New');
if(nb){nb.click();await new Promise(r=>setTimeout(r,1400))}
const ta=document.querySelector('.composer textarea');
if(!ta){say('FAILED no composer');return 'no-composer'}
const set=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
set.call(ta,${JSON.stringify(PROMPT)});
ta.dispatchEvent(new Event('input',{bubbles:true}));
await new Promise(r=>setTimeout(r,500));
ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
say('sent');
for(let i=0;i<220;i++){
  await new Promise(r=>setTimeout(r,10000));
  const busy=!!document.querySelector('.dot-busy,.tool-state-progress');
  const rc=[...document.querySelectorAll('.reasoning-count')].pop()?.textContent?.trim()??'-';
  say((busy?'busy ':'idle ')+rc);
}
return 'ok';
`

function runApp(effort, outPng) {
  return new Promise((done) => {
    const child = spawn('node', ['scripts/shoot.mjs', 'code', outPng], {
      cwd: ROOT,
      env: {
        ...process.env,
        LH_SHOT_DRIVE: drive(effort),
        LH_SHOT_AFTER_MS: '2500',
        LH_SHOT_DEADLINE_MS: String(PER_RUN_MS)
      },
      stdio: 'ignore'
    })
    const t = setTimeout(() => child.kill('SIGTERM'), PER_RUN_MS + 60_000)
    child.on('exit', () => {
      clearTimeout(t)
      done()
    })
  })
}

/* ---- run ---- */
const original = JSON.parse(await readFile(SETTINGS, 'utf8')).workflowReasoning ?? {}
const results = []

console.log(`\n\x1b[1mReasoning battery\x1b[0m — ${EFFORTS.join(', ')} · one at a time\n`)

for (const effort of EFFORTS) {
  await clearGames()
  await setEffort(effort)
  const png = join(SHOTS, `battery-${effort}.png`)
  const t0 = Date.now()
  process.stdout.write(`  ${effort.padEnd(7)} running… `)
  await runApp(effort, png)
  const secs = Math.round((Date.now() - t0) / 1000)

  const files = await gameFiles()
  let bytes = 0
  for (const f of files) bytes += (await stat(join(WORKSPACE, f))).size
  const ok = files.length > 0 && bytes > 2000
  results.push({ effort, secs, files: files.join(', ') || '(none)', bytes, ok })
  console.log(
    `${ok ? '\x1b[32mFILE\x1b[0m' : '\x1b[31mnone\x1b[0m'}  ${String(secs).padStart(4)}s  ` +
      `${bytes ? (bytes / 1024).toFixed(1) + 'KB' : '—'}  ${files.join(', ')}`
  )
  // Keep a copy so a later run cannot overwrite the evidence.
  for (const f of files) {
    await writeFile(join(SHOTS, `galaxy-${effort}.html`), await readFile(join(WORKSPACE, f)))
  }
  await sleep(5000)
}

/* ---- restore ---- */
const s = JSON.parse(await readFile(SETTINGS, 'utf8'))
s.workflowReasoning = original
await writeFile(SETTINGS, JSON.stringify(s, null, 2))

console.log('\n\x1b[1m  effort   outcome   elapsed   size\x1b[0m')
for (const r of results) {
  console.log(
    `  ${r.effort.padEnd(8)} ${(r.ok ? 'built' : 'FAILED').padEnd(9)} ${String(r.secs).padStart(5)}s   ` +
      `${r.bytes ? (r.bytes / 1024).toFixed(1) + 'KB' : '—'}`
  )
}
const winners = results.filter((r) => r.ok)
console.log(
  winners.length
    ? `\n  fastest that actually built: ${winners.sort((a, b) => a.secs - b.secs)[0].effort}\n`
    : '\n  nothing built at any setting — the problem is not the effort knob\n'
)
console.log(`  settings restored to ${JSON.stringify(original)}\n`)
