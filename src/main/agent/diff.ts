/**
 * Unified diff, LCS-based, no dependency.
 *
 * Used for the approval card: the user has to be able to read exactly what a
 * write_file or edit_file would do before they allow it, so the output has to
 * be a real unified diff — the kind `git apply` would accept — not a summary.
 */

/** Lines of leading/trailing context around each change. */
const CONTEXT = 3

/**
 * Ceiling on the LCS table. 4M cells is 16MB of Uint32Array; past that we stop
 * being clever and emit the change as a wholesale replacement rather than
 * stalling the main process on a quadratic table.
 */
const MAX_LCS_CELLS = 4_000_000

type OpKind = 'eq' | 'del' | 'add'

interface Op {
  kind: OpKind
  text: string
}

interface Split {
  lines: string[]
  /** True when the text does not end in a newline (and is not empty). */
  noEol: boolean
}

function splitLines(text: string): Split {
  if (text === '') return { lines: [], noEol: false }
  const noEol = !text.endsWith('\n')
  const body = noEol ? text : text.slice(0, -1)
  return { lines: body.split('\n'), noEol }
}

function replaceAll(a: string[], b: string[]): Op[] {
  const ops: Op[] = []
  for (const text of a) ops.push({ kind: 'del', text })
  for (const text of b) ops.push({ kind: 'add', text })
  return ops
}

/** Classic LCS backtrack over the already-trimmed middle section. */
function lcsOps(a: string[], b: string[]): Op[] {
  if (a.length === 0 || b.length === 0) return replaceAll(a, b)
  if ((a.length + 1) * (b.length + 1) > MAX_LCS_CELLS) return replaceAll(a, b)

  const w = b.length + 1
  const dp = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)])
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', text: a[i] })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      ops.push({ kind: 'del', text: a[i] })
      i++
    } else {
      ops.push({ kind: 'add', text: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ kind: 'del', text: a[i++] })
  while (j < b.length) ops.push({ kind: 'add', text: b[j++] })
  return ops
}

/** Trim the identical head and tail before running LCS on what is left. */
function diffOps(oldSplit: Split, newSplit: Split): Op[] {
  const a = oldSplit.lines
  const b = newSplit.lines

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let endA = a.length
  let endB = b.length
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ kind: 'eq', text: a[i] })
  ops.push(...lcsOps(a.slice(head, endA), b.slice(head, endB)))
  for (let i = endA; i < a.length; i++) ops.push({ kind: 'eq', text: a[i] })

  // A change that only adds or removes the trailing newline leaves the line
  // arrays identical, so LCS sees no difference at all. Force the final line
  // into a del/add pair so the "\ No newline at end of file" marker has
  // something to attach to and the change is actually visible.
  if (oldSplit.noEol !== newSplit.noEol && ops.length > 0) {
    const last = ops[ops.length - 1]
    if (last.kind === 'eq') {
      ops.pop()
      ops.push({ kind: 'del', text: last.text }, { kind: 'add', text: last.text })
    }
  }

  return ops
}

interface Anchored {
  op: Op
  /** 1-based old-file line this op occupies; for 'add', the last old line consumed. */
  o: number
  /** 1-based new-file line this op occupies; for 'del', the last new line consumed. */
  n: number
}

function anchor(ops: Op[]): Anchored[] {
  let o = 0
  let n = 0
  return ops.map((op) => {
    if (op.kind !== 'add') o++
    if (op.kind !== 'del') n++
    return { op, o, n }
  })
}

function header(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`
}

/**
 * A unified diff of `oldText` -> `newText`, labelled with `path`.
 * Returns '' when the two texts are identical.
 */
export function unifiedDiff(oldText: string, newText: string, path: string): string {
  const oldSplit = splitLines(oldText)
  const newSplit = splitLines(newText)
  const ops = diffOps(oldSplit, newSplit)

  const changed: number[] = []
  ops.forEach((op, i) => {
    if (op.kind !== 'eq') changed.push(i)
  })
  if (changed.length === 0) return ''

  // Merge each change's context window into hunks.
  const ranges: Array<[number, number]> = []
  for (const idx of changed) {
    const from = Math.max(0, idx - CONTEXT)
    const to = Math.min(ops.length - 1, idx + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else ranges.push([from, to])
  }

  const ann = anchor(ops)
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]

  for (const [from, to] of ranges) {
    let oldCount = 0
    let newCount = 0
    let oldStart = -1
    let newStart = -1
    for (let i = from; i <= to; i++) {
      const { op, o, n } = ann[i]
      if (op.kind !== 'add') {
        oldCount++
        if (oldStart < 0) oldStart = o
      }
      if (op.kind !== 'del') {
        newCount++
        if (newStart < 0) newStart = n
      }
    }
    // A hunk with nothing on one side sits *after* the last consumed line of
    // that side, which is what `@@ -0,0 ... @@` means for a new file.
    if (oldStart < 0) oldStart = ann[from].o
    if (newStart < 0) newStart = ann[from].n

    out.push(`@@ -${header(oldStart, oldCount)} +${header(newStart, newCount)} @@`)

    for (let i = from; i <= to; i++) {
      const { op, o, n } = ann[i]
      const marker = op.kind === 'del' ? '-' : op.kind === 'add' ? '+' : ' '
      out.push(marker + op.text)

      const lastOld = op.kind !== 'add' && o === oldSplit.lines.length && oldSplit.noEol
      const lastNew = op.kind !== 'del' && n === newSplit.lines.length && newSplit.noEol
      if (lastOld || lastNew) out.push('\\ No newline at end of file')
    }
  }

  return out.join('\n') + '\n'
}

/** Added and removed line counts for the same diff, without rendering it. */
export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  const ops = diffOps(splitLines(oldText), splitLines(newText))
  let added = 0
  let removed = 0
  for (const op of ops) {
    if (op.kind === 'add') added++
    else if (op.kind === 'del') removed++
  }
  return { added, removed }
}
