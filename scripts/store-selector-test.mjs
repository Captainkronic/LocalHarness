#!/usr/bin/env node
/**
 * A store selector must never build a fresh object or array.
 *
 * zustand reads through useSyncExternalStore, which compares snapshots with
 * Object.is. A selector that constructs its return value hands back a new
 * reference on every read, so the store reports "changed" forever: React
 * re-renders, reads again, sees another new object, and gives up with
 *
 *   Uncaught Error: Minified React error #185
 *
 * The window then paints black with nothing in it to say why, and the minified
 * stack names only forceStoreRerender — no component, no file.
 *
 * This shipped twice in one build. `?? []` when no conversation is loaded, and
 * a `stepRange` selector returning `{ lo, hi }`. Neither is visible in review
 * and neither fails a type check: both are correct code that happens to be
 * unsafe in this one position. So it is checked mechanically instead.
 *
 * The fix in both cases is the same shape: select the stable REFERENCE, and
 * derive in useMemo.
 *
 *   const messages = useStore((s) => s.conversation?.messages)
 *   const range = useMemo(() => compute(messages), [messages])
 *
 *   node scripts/store-selector-test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/renderer')

let failures = 0
const check = (name, ok, note = '') => {
  if (ok) console.log(`  \x1b[32mok\x1b[0m   ${name}`)
  else {
    failures++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${note ? ` — ${note}` : ''}`)
  }
}

const files = []
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) files.push(p)
  }
}
walk(SRC)

/** Every useStore(...) call body, brace-matched so multi-line ones are caught. */
function* selectors(src) {
  const re = /useStore\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let j = m.index + m[0].length
    const start = j
    while (j < src.length && depth > 0) {
      const c = src[j]
      if (c === '(') depth++
      else if (c === ')') depth--
      j++
    }
    yield { body: src.slice(start, j - 1), index: m.index }
  }
}

/**
 * Only the RETURNED expression matters. A block body may build all the
 * temporaries it likes as long as what leaves is a primitive or a reference
 * that already lived in the store.
 */
function returnsFreshValue(body) {
  const trimmed = body.trim()
  const arrow = /^\([^)]*\)\s*=>\s*/.exec(trimmed) ?? /^[A-Za-z_$][\w$]*\s*=>\s*/.exec(trimmed)
  if (arrow === null) return false
  const after = trimmed.slice(arrow[0].length).trim()

  // Concise body: `(s) => ({ ... })` or `(s) => [ ... ]`
  if (after.startsWith('({') || after.startsWith('[')) return true

  // Block body: inspect each `return`.
  if (after.startsWith('{')) {
    if (/\breturn\s+[[{]/.test(after)) return true
    // `?? []` / `?? {}` as the returned fallback is the same trap.
    if (/\breturn\s+[^\n;]*\?\?\s*(\[\s*\]|\{\s*\})/.test(after)) return true
    return false
  }

  // Expression body ending in a fresh fallback: `(s) => s.x ?? []`
  if (/\?\?\s*\[\s*\]\s*$/.test(after) || /\?\?\s*\{\s*\}\s*$/.test(after)) return true
  return false
}

console.log('\n\x1b[1mno store selector may construct its return value\x1b[0m')

const offenders = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const { body } of selectors(src)) {
    if (returnsFreshValue(body)) {
      offenders.push(`${relative(ROOT, f)}: ${body.split('\n')[0].trim().slice(0, 70)}`)
    }
  }
}

check(
  'every selector returns a primitive or an existing reference',
  offenders.length === 0,
  offenders.length > 0
    ? `${offenders.length} build a new value:\n       ${offenders.join('\n       ')}`
    : ''
)

/* The detector has to be able to see the two that actually shipped, or it is
   a test that passes because it cannot fail. */
console.log('\n\x1b[1mand the check can still see the bugs it was written for\x1b[0m')
check(
  'it catches the `?? []` fallback',
  returnsFreshValue('(s) => s.conversation?.messages ?? []')
)
check(
  'it catches a returned object literal',
  returnsFreshValue('(s) => { const a = 1\n return { lo: a, hi: a } }')
)
check(
  'it catches a concise object body',
  returnsFreshValue('(s) => ({ a: s.a, b: s.b })')
)
check(
  'and it does NOT flag a plain property read',
  !returnsFreshValue('(s) => s.conversation?.messages')
)
check(
  'nor a primitive fallback',
  !returnsFreshValue('(s) => s.conversation?.trimmedMessages ?? 0')
)
check(
  'nor a block body that returns a primitive',
  !returnsFreshValue('(s) => { const m = s.x.at(-1)\n return m?.error ? m.error : null }')
)

console.log(
  failures === 0 ? '\n\x1b[32mall checks passed\x1b[0m\n' : `\n\x1b[31m${failures} failed\x1b[0m\n`
)
process.exit(failures === 0 ? 0 : 1)
