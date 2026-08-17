#!/usr/bin/env node
/**
 * Reports what CaptainLlama can actually reach on this Mac.
 *
 * Written because "does it have permission" is not answerable by reading
 * config: macOS decides at runtime, per app, and the only honest test is to try
 * the thing. So this tries. It changes nothing and grants nothing — TCC
 * approval is the user's to give in System Settings, by design.
 *
 *   node scripts/permissions.mjs
 */
import { readdir, access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const APP = '/Applications/CaptainLlama.app'
const SETTINGS = join(homedir(), 'Library/Application Support/localharness/settings.json')

const row = (ok, name, note = '') =>
  console.log(`  ${ok === null ? '\x1b[33m ?  \x1b[0m' : ok ? '\x1b[32m ok \x1b[0m' : '\x1b[31mNO  \x1b[0m'} ${name.padEnd(34)}\x1b[2m${note}\x1b[0m`)

console.log('\n\x1b[1mCaptainLlama — what it can reach\x1b[0m\n')

/* ---- the app itself ---- */
let plist = {}
try {
  const { stdout } = await run('plutil', ['-convert', 'json', '-o', '-', join(APP, 'Contents/Info.plist')])
  plist = JSON.parse(stdout)
  row(true, 'app installed', `${plist.CFBundleIdentifier} ${plist.CFBundleShortVersionString ?? ''}`)
} catch {
  row(false, 'app installed', `${APP} not found — run npm run package`)
}

console.log('\n\x1b[1mDeclared reasons\x1b[0m \x1b[2m(without these macOS shows a generic prompt or fails quietly)\x1b[0m')
for (const [key, label] of [
  ['NSMicrophoneUsageDescription', 'microphone (Live)'],
  ['NSCameraUsageDescription', 'camera (Live video)'],
  ['NSDocumentsFolderUsageDescription', 'Documents (workspaces)'],
  ['NSDownloadsFolderUsageDescription', 'Downloads (attachments)'],
  ['NSDesktopFolderUsageDescription', 'Desktop (workspaces)'],
  ['NSAppleEventsUsageDescription', 'Apple Events (reveal in Finder)']
]) row(typeof plist[key] === 'string' && plist[key].length > 0, label)

/* ---- what it will actually try to open ---- */
console.log('\n\x1b[1mWorkspace roots\x1b[0m \x1b[2m(the folders the Code workflow is allowed to touch)\x1b[0m')
let roots = []
try {
  roots = JSON.parse(await readFile(SETTINGS, 'utf8')).workspaceRoots ?? []
} catch {
  row(null, 'settings.json', 'not readable — has the app been launched?')
}
if (roots.length === 0) row(null, 'no roots configured', 'add one in the Code workflow')
for (const r of roots) {
  try {
    const n = (await readdir(r)).length
    const protectedDir = /\/(Documents|Desktop|Downloads)(\/|$)/.test(r)
    row(true, r.replace(homedir(), '~'), `${n} entries${protectedDir ? ' · in a protected folder' : ''}`)
  } catch (err) {
    row(false, r.replace(homedir(), '~'), err.code === 'EPERM' ? 'permission denied' : String(err.code ?? err))
  }
}

/* ---- the protected folders themselves ---- */
console.log('\n\x1b[1mProtected folders\x1b[0m \x1b[2m(this shell, not the app — the app is asked separately)\x1b[0m')
for (const d of ['Documents', 'Desktop', 'Downloads']) {
  try {
    await access(join(homedir(), d))
    await readdir(join(homedir(), d))
    row(true, `~/${d}`)
  } catch {
    row(false, `~/${d}`, 'denied to this terminal')
  }
}

/* ---- things the app deliberately does NOT need ---- */
console.log('\n\x1b[1mNot required\x1b[0m')
row(true, 'Screen Recording', 'the app photographs its own window (capturePage)')
row(true, 'Accessibility', 'nothing drives other apps')
row(true, 'Full Disk Access', 'only the workspace roots above are ever read')

console.log(`
\x1b[1mIf something above says NO\x1b[0m
  Microphone / Camera   System Settings > Privacy & Security > Microphone / Camera
  Documents & friends   System Settings > Privacy & Security > Files and Folders > CaptainLlama
  Nothing listed there? macOS only lists an app once it has ASKED. Start a call
  or open a workspace, let the prompt appear, then the toggle exists.
`)
