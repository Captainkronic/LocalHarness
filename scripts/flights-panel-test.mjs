#!/usr/bin/env node
/**
 * Renders the real Flights panel against a real trip payload.
 *
 * The fixture is what the live server actually sent for a JFK-LIS day — 92
 * fares grouped into 33 flights, one shortlisted, one thing remembered, a
 * filter applied. A hand-written fixture would agree with whatever this panel
 * believed about the shape, which is the failure mode worth avoiding: the panel
 * is the ONLY consumer of that payload, so nothing else would catch a rename.
 *
 * Writes __panel-preview.html when run with --preview, for looking at.
 *
 *   node scripts/flights-panel-test.mjs [--preview]
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

const trip = JSON.parse(await readFile(join(ROOT, 'scripts/fixtures/flights-trip.json'), 'utf8'))
/* Inside the repo, not /tmp. React is left EXTERNAL rather than bundled —
   react-dom/server is CJS and reaches for `require('util')`, which an ESM
   bundle cannot answer — and an external import only resolves if the emitted
   file has this project's node_modules above it. */
const dir = await mkdtemp(join(ROOT, 'node_modules', '.lh-panel-'))

const render = async (structured) => {
  await writeFile(
    join(dir, 'store.tsx'),
    `export const useStore = (sel: any) => sel({ conversation: { messages: [{ toolCalls: [
       { name: 'flights__search_flights', status: 'ok', structured: ${JSON.stringify(structured)} }
     ] }] } })\n`
  )
  await writeFile(
    join(dir, 'e.tsx'),
    `import { renderToStaticMarkup } from 'react-dom/server'
     import { FlightsPanel } from '${ROOT}/src/renderer/components/panels/FlightsPanel'
     export const html = renderToStaticMarkup(<FlightsPanel />)\n`
  )
  const outfile = join(dir, `b${Math.abs(JSON.stringify(structured).length)}.mjs`)
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
    // The entry lives in a temp dir, so bare imports (react, react-dom/server)
    // have no node_modules above them to find.
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

console.log('\n\x1b[1mflights panel\x1b[0m')
const html = await render(trip)
const text = html.replace(/<[^>]+>/g, ' ')

check('the route is stated', text.includes(trip.brief.origin) && text.includes(trip.brief.destination))
/* The panel and the voice must say the date the same way. Reading 2026-10-15
   while hearing "Thursday the fifteenth" makes you check they match. */
check('the date is written the way it is spoken', !text.includes(trip.brief.date), 'raw ISO date on screen')
check('every option is drawn', trip.itineraries.every((i) => html.includes(`>${i.n}<`)))
check(
  'the headline price is the cheapest fare',
  text.includes(String(Math.round(trip.itineraries[0].from)))
)

/* The denominator. A list of eight with no total reads as "that is all there
   is", which is the one thing it is not. */
check('it says what was searched, not just what is shown', text.includes(String(trip.counts.fares)))
check('and how many flights matched', text.includes(String(trip.counts.matched)))

const overnight = trip.itineraries.find((i) => i.legs[0].dayOffset > 0)
check('an overnight arrival is marked', !overnight || html.includes('fl-next-day'), 'no +1 shown')

const laddered = trip.itineraries.find((i) => i.fares.length > 1)
check('the fare ladder is drawn', !laddered || html.includes('fl-fare'))
check(
  'a fare says what it includes',
  /cabin only|\d bag/.test(text),
  'no baggage wording anywhere'
)

const saved = trip.itineraries.filter((i) => i.shortlisted)
check('a shortlist gets its own section', saved.length === 0 || text.includes('Shortlist'))
check('and the saved card is marked', saved.length === 0 || html.includes('is-saved'))
check('remembered notes are shown', trip.notes.length === 0 || text.includes(trip.notes[0]))
check('applied filters are shown', trip.filterLabels.length === 0 || text.includes(trip.filterLabels[0]))
check('test data is captioned', trip.environment === 'production' || text.includes('Test data'))

const connecting = trip.itineraries.find((i) => i.stops > 0)
check('a connection names where it stops', !connecting || text.includes(connecting.legs[0].via[0]))

/* The panel is fed by a tool, and a tool can return anything. Every one of
   these used to be a white screen rather than an empty state. */
console.log('\n\x1b[1mmalformed payloads\x1b[0m')
for (const [name, payload] of [
  ['null', null],
  ['a string', 'nope'],
  ['an empty object', {}],
  ['no itineraries key', { brief: {} }],
  ['itineraries not an array', { brief: {}, itineraries: 'lots' }],
  ['an empty result', { ...trip, itineraries: [], counts: {}, history: [] }]
]) {
  try {
    const out = await render(payload)
    check(`${name} renders something`, out.length > 0)
  } catch (err) {
    check(`${name} renders something`, false, String(err).slice(0, 70))
  }
}

if (process.argv.includes('--preview')) {
  const css = [
    await readFile(join(ROOT, 'src/renderer/styles/theme.css'), 'utf8'),
    await readFile(join(ROOT, 'src/renderer/components/panels/panels.css'), 'utf8')
  ].join('\n')
  await writeFile(
    join(ROOT, '__panel-preview.html'),
    `<!doctype html><meta charset=utf8><title>panel</title><style>${css}
     body{margin:0;background:var(--bg-void);color:var(--fg);font-family:var(--font-ui,system-ui);padding:16px}
     .wrap{width:392px}</style><div class="wrap">${html}</div>`
  )
  console.log('\n  wrote __panel-preview.html')
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
