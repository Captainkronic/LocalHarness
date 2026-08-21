#!/usr/bin/env node
/**
 * Files made in a conversation must be recorded, and previewable.
 *
 * Three bugs here shared one shape: the code looked correct and failed
 * silently.
 *
 * 1. The spoken path called mcp.callTool and dropped result.artifacts on the
 *    floor. That was RIGHT for Live, which only ever had read-only servers, and
 *    the comment said so. Converse broke the premise — docgen, comfy-image and
 *    comfy-audio — so asking out loud for a PDF produced the PDF, said so, and
 *    recorded nothing.
 *
 * 2. Artifacts often carry a file:// URL as well as a path. Handing that to an
 *    <img> or <embed> renders nothing, with no error: the renderer is not
 *    permitted to read the filesystem. Local files must go through main.
 *
 * 3. sips renders a PDF page onto TRANSPARENCY, because a PDF page has no
 *    background of its own. Shown without paper under it, the document
 *    composites over whatever is behind — which looks exactly like a z-index
 *    bug and is not one.
 *
 *   node scripts/outputs-panel-test.mjs
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8')

const session = read('src/main/live/session.ts')
const index = read('src/main/index.ts')
const mainIpc = read('src/main/ipc.ts')
const panel = read('src/renderer/components/panels/OutputsPanel.tsx')
const css = read('src/renderer/components/panels/panels.css')

/* ---- 1. a spoken turn records what it made ----------------------------- */

check(
  'the session takes an onArtifact dependency',
  /onArtifact:\s*\(/.test(session)
)
check(
  'and calls it for every artifact a tool returns',
  /result\.artifacts[\s\S]{0,200}?this\.o\.onArtifact\(/.test(session),
  'without this a spoken "make me a PDF" writes the file and records nothing'
)
check(
  'main both stores and broadcasts it',
  /onArtifact:\s*\([^)]*\)\s*=>\s*\{[\s\S]{0,300}?artifacts\.add\([\s\S]{0,200}?emit\('event:artifact'/.test(
    index
  ),
  'storing only would lose it on reload; emitting only would lose it on switch'
)
check(
  'the stale "no artifact recording" claim is gone from the doc comment',
  !/no\s*\n?\s*\*?\s*artifact recording/.test(session)
)

/* ---- 2. local files are read through main, never by the renderer ------- */

check(
  'the panel refuses to hand a non-http URL to the DOM',
  /function remoteUrl[\s\S]{0,300}?\/\^https\?:/.test(panel),
  'a file:// src renders nothing, silently'
)
check(
  'and recovers a path from a file:// URL rather than giving up',
  /function localPath[\s\S]{0,400}?startsWith\('file:\/\/'\)/.test(panel)
)
check(
  'every img/embed/audio src in the panel comes from a guarded resolution',
  !/src=\{artifact\.url\}/.test(panel) && !/src=\{a\.url\}/.test(panel)
)

/* ---- 3. previews ------------------------------------------------------- */

check(
  'the preview channel exists and is allowlisted by extension',
  /'artifacts:preview'/.test(mainIpc) && /PREVIEWABLE\[ext\]/.test(mainIpc),
  'this hands file bytes to the renderer; it must not read anything asked for'
)
check(
  'a PDF is rendered to an image rather than embedded',
  /renderPdfFirstPage/.test(mainIpc) && /renderedFrom: 'pdf'/.test(mainIpc),
  "Chromium's viewer paints nothing in a packaged build"
)
check(
  'the temp file sips writes is always removed',
  /finally\s*\{[\s\S]{0,160}?rm\(out/.test(mainIpc),
  'a preview must not leave a copy of every document it showed in /tmp'
)
check(
  'the panel says a PDF preview is only the first page',
  /renderedFrom === 'pdf'[\s\S]{0,400}?First page/.test(panel),
  'otherwise a ten-page report looks like a one-page one'
)
check(
  'a rendered page is given an opaque background',
  /\.op-page\s*\{[^}]*background:\s*#fff/.test(css),
  'sips renders onto transparency; without paper the document composites over the app'
)
check(
  'blob URLs are revoked',
  /revokeObjectURL/.test(panel),
  'every preview would otherwise hold its file until the window closes'
)

/* ---- 4. the panel is actually reachable -------------------------------- */

check(
  "Converse's panel is wired to it",
  /panel: 'outputs'/.test(read('src/shared/workflows.ts')) &&
    /kind === 'outputs' \? <OutputsPanel/.test(read('src/renderer/components/panels/ContextPanel.tsx'))
)

console.log(
  failures === 0
    ? '\n\x1b[32mall outputs-panel checks passed\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed\x1b[0m`
)
process.exit(failures === 0 ? 0 : 1)
