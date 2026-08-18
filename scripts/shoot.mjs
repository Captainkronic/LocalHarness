#!/usr/bin/env node
/**
 * Screenshot the app without any Screen Recording permission.
 *
 * `screencapture(1)` HANGS rather than failing when the responsible app lacks
 * the TCC grant, which makes it useless from a script. Electron can capture its
 * own window instead, so the app does it from the inside — see
 * src/main/screenshot.ts. This just drives it.
 *
 *   node scripts/shoot.mjs [workflowId] [outFile]
 *
 * The workflow is selected by writing it into the settings file before launch,
 * because the renderer restores the last active workflow on boot.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'

const workflow = process.argv[2] ?? 'chat'
const outFile = resolve(process.argv[3] ?? `./shots/${workflow}.png`)
const settingsPath = `${homedir()}/Library/Application Support/LocalHarness/settings.json`

// Point the app at the workflow we want to photograph.
if (existsSync(settingsPath)) {
  try {
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'))
    s.lastWorkflow = workflow
    writeFileSync(settingsPath, JSON.stringify(s, null, 2))
  } catch {
    // A malformed settings file is the app's problem, not the screenshotter's.
  }
}

mkdirSync(dirname(outFile), { recursive: true })
rmSync(outFile, { force: true })

// detached puts the child in its OWN process group, which is the only way to
// reap what it spawns: `npm run dev` starts electron-vite which starts Electron,
// and killing npm leaves the Electron window running forever. Four of them
// accumulated on Adam's screen over an hour of driven runs before this was
// noticed, each showing an error because the settings file kept changing under
// it. Kill the group, not the process.
const child = spawn('npm', ['run', 'dev'], {
  detached: true,
  env: {
    ...process.env,
    LH_SHOT_DIR: dirname(outFile),
    LH_SHOT_NAME: outFile.split('/').pop(),
    LH_SHOT_AFTER_MS: process.env.LH_SHOT_AFTER_MS ?? '7000',
    LH_SHOT_EXIT: '1',
    LH_START_WORKFLOW: workflow,
    // Pass through so a caller can pin a Live call state:
    //   LH_LIVE_STATE=tool node scripts/shoot.mjs live shots/live-tool.png
    ...(process.env.LH_LIVE_STATE ? { LH_LIVE_STATE: process.env.LH_LIVE_STATE } : {}),
    ...(process.env.LH_AVATAR_BUILDER
      ? { LH_AVATAR_BUILDER: process.env.LH_AVATAR_BUILDER }
      : {}),
    ...(process.env.LH_CODE_MODE ? { LH_CODE_MODE: process.env.LH_CODE_MODE } : {}),
    // A snippet run in the renderer before the frame is taken, so states that
    // must be REACHED — a rejected send, an open dialog — can be photographed.
    //   LH_SHOT_DRIVE="document.querySelector('textarea').focus()" node scripts/shoot.mjs chat out.png
    ...(process.env.LH_SHOT_DRIVE ? { LH_SHOT_DRIVE: process.env.LH_SHOT_DRIVE } : {}),
    ...(process.env.LH_SHOT_SETTLE_MS ? { LH_SHOT_SETTLE_MS: process.env.LH_SHOT_SETTLE_MS } : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let out = ''
child.stdout.on('data', (d) => {
  out += d
})
child.stderr.on('data', (d) => {
  out += d
})

// 90s is right for a screenshot of a static screen and far too short for one
// that has to WAIT for something — two ComfyUI renders back to back is roughly
// seven minutes, and this deadline silently killed three attempts at verifying
// take lineage, each time looking like the app had failed rather than the
// harness. LH_SHOT_DEADLINE_MS raises it for those runs.
/** SIGTERM the whole group, then SIGKILL anything still standing. Electron does
 *  not always honour a TERM while a renderer is mid-frame. */
function reap() {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }, 4000).unref()
}

const deadline = setTimeout(reap, Number(process.env.LH_SHOT_DEADLINE_MS ?? 90_000))

// A harness that leaks a window when IT is interrupted is the same bug wearing
// a different hat.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { reap(); process.exit(130) })
process.on('exit', reap)

child.on('exit', () => {
  clearTimeout(deadline)
  if (existsSync(outFile)) {
    console.log(`saved ${outFile}`)
    process.exit(0)
  }
  console.error('no screenshot produced')
  console.error(out.split('\n').filter((l) => /shot|Error|error/.test(l)).slice(-10).join('\n'))
  process.exit(1)
})
