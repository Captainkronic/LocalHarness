#!/usr/bin/env node
/**
 * Renders the real Health panel against a real case payload.
 *
 * The fixture came from the live server: a man on warfarin who has started
 * taking ibuprofen for his knee, and the interaction check that follows. It is
 * the exact case the workflow exists to catch.
 *
 * The checks that matter here are not "does it look right". They are: does a
 * red flag reach the screen, is every source listed with a link, and is the
 * strength of the evidence shown next to the claim. A health panel that renders
 * beautifully and quietly drops one of those is worse than no panel.
 *
 *   node scripts/health-panel-test.mjs [--preview]
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

const base = JSON.parse(await readFile(join(ROOT, 'scripts/fixtures/health-case.json'), 'utf8'))
const dir = await mkdtemp(join(ROOT, 'node_modules', '.lh-health-'))

const render = async (structured, tag) => {
  await writeFile(
    join(dir, 'store.tsx'),
    `export const useStore = (sel: any) => sel({ conversation: { messages: [{ toolCalls: [
       { name: 'health__case_note', status: 'ok', structured: ${JSON.stringify(structured)} }
     ] }] } })\n`
  )
  await writeFile(
    join(dir, 'e.tsx'),
    `import { renderToStaticMarkup } from 'react-dom/server'
     import { HealthPanel } from '${ROOT}/src/renderer/components/panels/HealthPanel'
     export const html = renderToStaticMarkup(<HealthPanel />)\n`
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

console.log('\n\x1b[1mthe case file\x1b[0m')
const html = await render(base, 'base')
const text = html.replace(/<[^>]+>/g, ' ')

for (const list of ['medications', 'conditions', 'symptoms', 'questions', 'profile']) {
  const items = base[list] ?? []
  if (items.length === 0) continue
  check(`${list} reach the screen`, items.every((e) => text.includes(e.text)), items[0].text)
}

console.log('\n\x1b[1mevery claim is traceable\x1b[0m')
check('sources are listed', base.sources.every((s) => text.includes(s.title)))
check('and each one is a link', base.sources.every((s) => html.includes(`href="${s.url}"`)))
check('links open outside the app', !html.includes('href="http') || html.includes('target="_blank"'))
check(
  'and cannot reach back into it',
  !html.includes('target="_blank"') || html.includes('rel="noreferrer"'),
  'target=_blank without rel=noreferrer'
)

console.log('\n\x1b[1mthe interaction it exists to catch\x1b[0m')
const hits = base.last?.hits ?? []
check('the interaction is shown', hits.length === 0 || text.includes(hits[0].mentions))
check('with the label text behind it', hits.length === 0 || text.includes(hits[0].text.slice(0, 40)))
check('and which drugs were checked', text.includes((base.last?.checked ?? [''])[0]))

console.log('\n\x1b[1mred flags\x1b[0m')
const flagged = {
  ...base,
  redFlags: [
    {
      flag: 'chest pain with pressure or tightness',
      action: 'This is how a heart attack presents. Emergency services, now.',
      about: 'crushing pain in my chest'
    }
  ]
}
const alarmed = await render(flagged, 'flag')
const alarmedText = alarmed.replace(/<[^>]+>/g, ' ')
check('the flag is rendered', alarmedText.includes('chest pain with pressure'))
check('so is what to do about it', alarmedText.includes('Emergency services'))
check('and it is announced to a screen reader', alarmed.includes('role="alert"'))
/* Position is the point. Below the case file it is a footnote. */
check(
  'it comes before everything else on the page',
  alarmed.indexOf('hl-flags') < alarmed.indexOf('hl-group'),
  'red flag is not first'
)

console.log('\n\x1b[1mevidence is labelled\x1b[0m')
const research = {
  ...base,
  last: {
    kind: 'research',
    query: 'statins and muscle pain',
    papers: [
      {
        pmid: '1',
        title: 'A big meta-analysis',
        journal: 'Lancet',
        year: '2022',
        strength: 'systematic review or meta-analysis',
        url: 'https://pubmed.ncbi.nlm.nih.gov/1/',
        abstract: 'x'
      },
      {
        pmid: '2',
        title: 'One small study',
        journal: 'J Small',
        year: '2019',
        strength: 'single study',
        url: 'https://pubmed.ncbi.nlm.nih.gov/2/',
        abstract: 'y'
      }
    ]
  }
}
const ev = await render(research, 'ev')
check('the kind of evidence is shown', ev.includes('systematic review') && ev.includes('single study'))
check('and the strong one is marked as such', ev.includes('is-strong'))
check(
  'while the weak one is not',
  (ev.match(/is-strong/g) ?? []).length === 1,
  'both papers marked strong'
)

console.log('\n\x1b[1mmalformed payloads\x1b[0m')
for (const [name, payload] of [
  ['null', null],
  ['a string', 'nope'],
  ['an empty object', {}],
  ['no redFlags key', { symptoms: [], sources: [] }],
  ['an empty case', { ...base, profile: [], symptoms: [], medications: [], conditions: [], allergies: [], questions: [], redFlags: [], sources: [], last: null }]
]) {
  try {
    const out = await render(payload, name.replace(/\W/g, ''))
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
    join(ROOT, '__health-preview.html'),
    `<!doctype html><meta charset=utf8><title>health</title><style>${css}
     body{margin:0;background:var(--bg-void);color:var(--fg);font-family:var(--font-ui,system-ui);padding:16px}
     .wrap{width:392px}</style><div class="wrap">${alarmed}</div>`
  )
  console.log('\n  wrote __health-preview.html')
}

await rm(dir, { recursive: true, force: true })
console.log(failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`)
process.exit(failures === 0 ? 0 : 1)
