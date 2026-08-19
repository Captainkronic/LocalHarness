#!/usr/bin/env node
/**
 * Renders the Browser pane against a real capture sequence.
 *
 * The fixture is what the playwright MCP actually emitted for a page view
 * followed by a click: two frames, two vision readings, real paths. The checks
 * that matter are that the FRAME reaches the screen and that the vision text
 * sits beside it — a pane that shows one without the other is worse than
 * neither, because the whole point is being able to disagree with the model.
 *
 *   node scripts/browser-pane-test.mjs [--preview]
 */
import { build } from 'esbuild'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`)
  }
}

const views = JSON.parse(await readFile(join(ROOT, 'scripts/fixtures/browser-views.json'), 'utf8'))
const dir = await mkdtemp(join(ROOT, 'node_modules', '.lh-bp-'))

/** A real PNG, so the <img> is exercised rather than mocked away. */
const shot = views[0].screenshot
const dataUrl = await readFile(shot)
  .then((b) => `data:image/png;base64,${b.toString('base64')}`)
  .catch(() => null)

const render = async (payloads, tag, imageUrl = dataUrl) => {
  const calls = payloads
    .map((p, i) => `{ id:'c${i}', name:'playwright__view_page', status:'ok', structured:${JSON.stringify(p)} }`)
    .join(',')
  await writeFile(
    join(dir, 'store.tsx'),
    `export const useStore = (sel: any) => sel({
       conversation: { messages: [{ toolCalls: [${calls}] }] },
       readImageDataUrl: async () => ${JSON.stringify(imageUrl)}
     })\n`
  )
  await writeFile(
    join(dir, 'e.tsx'),
    `import { renderToStaticMarkup } from 'react-dom/server'
     import { BrowserPane } from '${ROOT}/src/renderer/components/code/BrowserPane'
     export const html = renderToStaticMarkup(<BrowserPane />)\n`
  )
  const outfile = join(dir, `b-${tag}.mjs`)
  await build({
    entryPoints: [join(dir, 'e.tsx')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    absWorkingDir: ROOT,
    nodePaths: [join(ROOT, 'node_modules')],
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    alias: {
      '@renderer/state/store': join(dir, 'store.tsx'),
      '@renderer': join(ROOT, 'src/renderer'),
      '@shared': join(ROOT, 'src/shared')
    }
  })
  const { html } = await import(pathToFileURL(outfile).href)
  return html
}

console.log('\n\x1b[1mbrowser pane\x1b[0m')
check('the fixture is a real sequence', views.length >= 2, `${views.length} frames`)

const html = await render(views, 'base')
const text = html.replace(/<[^>]+>/g, ' ')

/* Server-rendered, so the effect that loads the image has not run. What must be
   true here is the structure around it. */
check('the page title is shown', text.includes(views[views.length - 1].title))
check('and the url', text.includes(views[views.length - 1].url.slice(-30)))
check('the capture size is stated', /viewport/.test(text) && /captured/.test(text))

const vision = views[views.length - 1].vision
check('the vision reading is shown beside the frame', !vision || text.includes(vision.answer.slice(0, 40)))
check('and attributed to a model', !vision || text.includes(vision.model))

check('a filmstrip appears for multiple frames', html.includes('bp-strip'))
check('with one control per frame', (html.match(/bp-frame/g) ?? []).length >= views.length)

/* It follows the newest frame by default: the last capture is the one the model
   just acted on, and that is what you want to be looking at. */
check(
  'the newest frame is selected',
  html.includes('aria-selected="true"') &&
    html.lastIndexOf('is-on') > html.indexOf('bp-strip'),
  'no frame marked current'
)

console.log('\n\x1b[1mwhen the frame is gone\x1b[0m')
/* The shots directory is a cache. A frame from an older conversation may simply
   not exist, and a broken <img> with no explanation is the worst version. */
const gone = await render(views, 'gone', null)
check('it renders rather than breaking', gone.length > 0)

console.log('\n\x1b[1mmalformed payloads\x1b[0m')
for (const [name, payload] of [
  ['no screenshot path', [{ url: 'http://x', title: 't' }]],
  ['a string', ['nope']],
  ['null', [null]],
  ['empty', []]
]) {
  try {
    const out = await render(payload, name.replace(/\W/g, ''))
    check(`${name} renders the empty state`, out.length > 0 && !out.includes('undefined'))
  } catch (err) {
    check(`${name} renders the empty state`, false, String(err).slice(0, 70))
  }
}

if (process.argv.includes('--preview')) {
  const css = [
    await readFile(join(ROOT, 'src/renderer/styles/theme.css'), 'utf8'),
    await readFile(join(ROOT, 'src/renderer/components/code/code.css'), 'utf8'),
    await readFile(join(ROOT, 'src/renderer/components/panels/panels.css'), 'utf8')
  ].join('\n')
  /* The real pane loads the image through IPC in an effect; server rendering
     leaves the <img> out, so the preview injects it to show the true layout. */
  const withImg = html.replace(
    '<div class="bp-stage">',
    `<div class="bp-stage"><img class="bp-shot" src="${dataUrl}" alt="frame">`
  )
  await writeFile(
    join(ROOT, '__browser-preview.html'),
    `<!doctype html><meta charset=utf8><title>browser pane</title><style>${css}
     body{margin:0;background:var(--bg-app);color:var(--fg);font-family:var(--font-ui,system-ui)}
     .wrap{width:900px;margin:0 auto}</style><div class="wrap">${withImg}</div>`
  )
  console.log('\n  wrote __browser-preview.html')
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
