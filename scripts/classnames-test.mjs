#!/usr/bin/env node
/**
 * Fails when a component uses a CSS class that no stylesheet defines.
 *
 * This has shipped FOUR times — mcp-row-main, mcp-switch, mcp-knob in the
 * Skills panel, then mcp-foot-figures/-tok/-note in its footer, then
 * cw-add/cw-del in the Code mode bar. Every time the result looked like a
 * design decision rather than a bug: rows lost their layout and stacked, a
 * footer wrapped, change counts rendered in inherited grey. Nothing errors,
 * nothing warns, and the typechecker cannot see inside a string.
 *
 * So it is checked here. Deliberately conservative: only literal className
 * strings are extracted, and any class matching an allowlisted prefix is
 * skipped, because a false failure here would be worse than the bug.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer')

/** Classes owned by something other than our stylesheets. */
const EXTERNAL = [
  /^hljs/,          // syntax highlighting, injected
  /^language-/,     // markdown code fences
  /^token$/,
  /^katex/
]

/**
 * Classes left undefined on purpose because a parent rule paints them.
 *
 * Real and legitimate: an SVG group sets `fill` and `stroke` and its children
 * need no rule of their own. Every entry here is a decision someone checked,
 * not a suppression — if you add one, it is because you confirmed a parent
 * actually styles it.
 */
const INHERITS_FROM_PARENT = new Set([
  // painted by .orb-brackets / .orb-sweep / .orb-glyph's own parents
  'orb-glyph', 'orb-bars', 'orb-dots', 'orb-bar-2', 'orb-dot-1', 'orb-ping-1',
  'orb-bracket', 'orb-sweeps',
  'lv-said',            // coloured through .lv-reply[data-karaoke]
  'lvt-stat', 'src-time', 'aud-time', 'gal-lightbox-fact',
  'ed-draft',  // a container; its ed-draft-* children carry the rules
  'dir'        // a ternary operand inside a template literal, not a class
])

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
  return out
}

const files = await walk(SRC)
const cssFiles = files.filter((f) => extname(f) === '.css')
const tsxFiles = files.filter((f) => extname(f) === '.tsx')

/* ---- every class any stylesheet defines ---- */
const defined = new Set()
for (const f of cssFiles) {
  const css = await readFile(f, 'utf8')
  for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1])
}

/* ---- every class a component asks for ---- */
const used = new Map() // class -> "file:line"
for (const f of tsxFiles) {
  const src = await readFile(f, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    // Only QUOTED runs are class names. An earlier version also scraped the bare
    // identifiers out of cx(...) calls and duly reported `isDefault`, `on` and
    // `toolOn` as undefined classes — they are variables. A checker that cries
    // wolf gets switched off, so this reads string literals and nothing else.
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{[^}]*\})/g)) {
      const blobs =
        m[1] !== undefined
          ? [m[1]]
          : [
              // Comparison operands are not classes: `mode === 'watch' ? …`
              // put "watch" on the list until this stripped them.
              ...m[0].replace(/[=!]==?\s*(['"`])[^'"`]*\1/g, '').matchAll(/'([^']*)'|"([^"]*)"|`([^`$]*)`/g)
            ].map((q) => q[1] ?? q[2] ?? q[3])
      for (const blob of blobs) {
        for (const raw of String(blob ?? '').split(/\s+/)) {
          const c = raw.trim()
          if (!c || !/^-?[_a-zA-Z][\w-]*$/.test(c)) continue
          if (!used.has(c)) used.set(c, `${f.replace(SRC + '/', '')}:${i + 1}`)
        }
      }
    }
  })
}

const missing = [...used.entries()]
  .filter(([c]) => !defined.has(c))
  .filter(([c]) => !EXTERNAL.some((re) => re.test(c)) && !INHERITS_FROM_PARENT.has(c))
  .sort()

console.log(
  `\n\x1b[1mClass names\x1b[0m  ${defined.size} defined in ${cssFiles.length} stylesheets, ` +
    `${used.size} used across ${tsxFiles.length} components\n`
)

if (missing.length === 0) {
  console.log('\x1b[32mall classname checks passed\x1b[0m\n')
  process.exit(0)
}
for (const [c, where] of missing) {
  console.log(`  \x1b[31mundefined\x1b[0m .${c.padEnd(26)} \x1b[2m${where}\x1b[0m`)
}
console.log(
  `\n\x1b[31m${missing.length} class${missing.length === 1 ? '' : 'es'} used but never defined\x1b[0m` +
    `\n\x1b[2mAn unknown class fails silently and looks intentional. Define it, or use the real one.\x1b[0m\n`
)
process.exit(1)
