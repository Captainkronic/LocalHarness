/**
 * A small, dependency-free markdown renderer.
 *
 * Output is React elements built from parsed text — model output is never
 * handed to dangerouslySetInnerHTML, so escaping is React's problem and it
 * cannot inject markup.
 *
 * Streaming-safe: an unterminated fence renders as a code block still being
 * written rather than swallowing the rest of the message, and any inline
 * marker that has not closed yet renders as literal text.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './chat.css'

export interface MarkdownProps {
  text: string
}

export default function Markdown({ text }: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text.split('\n')), [text])
  return <div className="md">{renderBlocks(blocks, 'b')}</div>
}

/* ------------------------------------------------------------------ */
/* Block model                                                         */
/* ------------------------------------------------------------------ */

type Align = 'left' | 'center' | 'right'

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'code'; lang: string; code: string; open: boolean }
  | { kind: 'list'; ordered: boolean; start: number; items: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] }

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function leadingSpaces(line: string): number {
  let n = 0
  while (n < line.length && line[n] === ' ') n++
  return n
}

/** True for lines that end a paragraph or a lazy list continuation. */
function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line)
  )
}

function isOrderedMarker(marker: string): boolean {
  return /\d/.test(marker[0])
}

/** A header row followed by a `---|---` delimiter row. */
function isTableStart(lines: string[], i: number): boolean {
  const line = lines[i]
  const next = lines[i + 1]
  return (
    line !== undefined &&
    line.includes('|') &&
    next !== undefined &&
    next.includes('-') &&
    TABLE_DELIM_RE.test(next)
  )
}

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map((c) => c.trim())
}

function cellAlign(spec: string): Align {
  const s = spec.trim()
  if (s.startsWith(':') && s.endsWith(':')) return 'center'
  if (s.endsWith(':')) return 'right'
  return 'left'
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    /* --- fenced code (checked first: everything inside is literal) --- */
    const fence = FENCE_RE.exec(line)
    if (fence) {
      const marker = fence[1][0]
      const len = fence[1].length
      const body: string[] = []
      let j = i + 1
      let closed = false
      for (; j < lines.length; j++) {
        const t = lines[j].trim()
        if (t.length >= len && t[0] === marker && [...t].every((c) => c === marker)) {
          closed = true
          break
        }
        body.push(lines[j])
      }
      blocks.push({ kind: 'code', lang: fence[2] ?? '', code: body.join('\n'), open: !closed })
      i = closed ? j + 1 : j
      continue
    }

    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      i++
      continue
    }

    const quote = QUOTE_RE.exec(line)
    if (quote) {
      const inner: string[] = [quote[1]]
      let j = i + 1
      for (; j < lines.length; j++) {
        const q = QUOTE_RE.exec(lines[j])
        if (q) inner.push(q[1])
        else if (lines[j].trim() === '') break
        else inner.push(lines[j]) // lazy continuation
      }
      blocks.push({ kind: 'quote', lines: inner })
      i = j
      continue
    }

    /* --- table: header row plus a delimiter row --- */
    if (isTableStart(lines, i)) {
      const header = splitRow(line)
      const align = splitRow(lines[i + 1]).map(cellAlign)
      if (header.length > 0 && align.length === header.length) {
        const rows: string[][] = []
        let j = i + 2
        for (; j < lines.length && lines[j].trim() !== '' && lines[j].includes('|'); j++) {
          rows.push(splitRow(lines[j]))
        }
        blocks.push({ kind: 'table', header, align, rows })
        i = j
        continue
      }
    }

    /* --- list --- */
    const first = LIST_RE.exec(line)
    if (first) {
      const ordered = isOrderedMarker(first[2])
      const start = ordered ? Number.parseInt(first[2], 10) : 1
      const baseIndent = first[1].length
      const items: string[][] = []
      let j = i

      while (j < lines.length) {
        const m = LIST_RE.exec(lines[j])
        if (!m || m[1].length > baseIndent + 1 || isOrderedMarker(m[2]) !== ordered) break

        const contentIndent = m[1].length + m[2].length + m[3].length
        const item = [m[4]]
        j++

        // Continuation: deeper-indented lines belong to this item (which is how
        // nested lists and fenced code inside a bullet survive), and an
        // unindented plain line is a lazy continuation of the same paragraph.
        while (j < lines.length) {
          const next = lines[j]
          if (next.trim() === '') {
            const after = lines[j + 1]
            if (after !== undefined && after.trim() !== '' && leadingSpaces(after) >= contentIndent) {
              item.push('')
              j++
              continue
            }
            break
          }
          if (LIST_RE.test(next) && leadingSpaces(next) <= baseIndent + 1) break
          if (leadingSpaces(next) >= contentIndent) {
            item.push(next.slice(contentIndent))
            j++
            continue
          }
          if (!isBlockStart(next)) {
            item.push(next.trim())
            j++
            continue
          }
          break
        }
        items.push(item)
      }

      blocks.push({ kind: 'list', ordered, start, items })
      i = j
      continue
    }

    /* --- paragraph --- */
    const para: string[] = []
    const paraStart = i
    while (i < lines.length) {
      const l = lines[i]
      if (l.trim() === '' || isBlockStart(l) || LIST_RE.test(l)) break
      // A table interrupts a paragraph, but the paragraph must always consume
      // its own first line or the parser would spin.
      if (i > paraStart && isTableStart(lines, i)) break
      para.push(l.trim())
      i++
    }
    if (para.length > 0) blocks.push({ kind: 'para', text: para.join('\n') })
    else i++ // defensive: never spin on a line no branch consumed
  }

  return blocks
}

/* ------------------------------------------------------------------ */
/* Block rendering                                                     */
/* ------------------------------------------------------------------ */

function renderBlocks(blocks: Block[], kp: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${kp}-${idx}`
    switch (b.kind) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, b.level))
        const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return (
          <Tag key={key} className={`md-h md-h${level}`}>
            {renderInline(b.text, key)}
          </Tag>
        )
      }
      case 'para':
        return (
          <p key={key} className="md-p">
            {renderInline(b.text, key)}
          </p>
        )
      case 'code':
        return <CodeBlock key={key} lang={b.lang} code={b.code} open={b.open} />
      case 'hr':
        return <hr key={key} className="md-hr" />
      case 'quote':
        return (
          <blockquote key={key} className="md-quote">
            {renderBlocks(parseBlocks(b.lines), key)}
          </blockquote>
        )
      case 'list': {
        const children = b.items.map((item, k) => (
          <li key={`${key}-i${k}`}>{renderItem(item, `${key}-i${k}`)}</li>
        ))
        return b.ordered ? (
          <ol key={key} className="md-list" start={b.start}>
            {children}
          </ol>
        ) : (
          <ul key={key} className="md-list">
            {children}
          </ul>
        )
      }
      case 'table':
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {b.header.map((h, k) => (
                    <th key={`${key}-h${k}`} style={{ textAlign: b.align[k] ?? 'left' }}>
                      {renderInline(h, `${key}-h${k}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={`${key}-r${r}`}>
                    {b.header.map((_, c) => (
                      <td key={`${key}-r${r}c${c}`} style={{ textAlign: b.align[c] ?? 'left' }}>
                        {renderInline(row[c] ?? '', `${key}-r${r}c${c}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

/** A single-line item stays inline; anything richer re-enters the block parser. */
function renderItem(lines: string[], key: string): ReactNode {
  if (lines.length === 1) return renderInline(lines[0], key)
  return renderBlocks(parseBlocks(lines), key)
}

function CodeBlock({ lang, code, open }: { lang: string; code: string; open: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    []
  )

  const copy = (): void => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true)
        if (timer.current !== undefined) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setCopied(false), 1200)
      },
      () => setCopied(false)
    )
  }

  return (
    <div className={open ? 'md-code md-code-open' : 'md-code'}>
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'text'}</span>
        {open ? <span className="md-code-writing">writing…</span> : null}
        <button type="button" className="btn btn-ghost btn-sm md-copy" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Inline rendering                                                    */
/* ------------------------------------------------------------------ */

/*
 * Alternation order is the precedence: code spans win over everything (their
 * contents are literal), links before emphasis, ** before *. A fresh RegExp per
 * call keeps `lastIndex` private, which matters because emphasis recurses.
 */
const INLINE_SOURCE = [
  '(`+)([\\s\\S]*?)\\1', // 1,2 code span
  '!\\[([^\\]]*)\\]\\(([^()\\s]+)\\)', // 3,4 image
  '\\[([^\\]]*)\\]\\(([^()\\s]+)\\)', // 5,6 link
  '\\*\\*([\\s\\S]+?)\\*\\*', // 7 strong
  '__([\\s\\S]+?)__', // 8 strong
  '~~([\\s\\S]+?)~~', // 9 strike
  '\\*([^\\s*](?:[^*\\n]*?[^\\s*])?)\\*', // 10 emphasis
  '_([^\\s_](?:[^_\\n]*?[^\\s_])?)_', // 11 emphasis
  '<(https?://[^>\\s]+)>', // 12 autolink
  "(https?://[^\\s<>`\"')\\]]+)" // 13 bare url
].join('|')

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /\w/.test(c)
}

function renderInline(src: string, kp: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = new RegExp(INLINE_SOURCE, 'g')
  let last = 0
  let n = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(src)) !== null) {
    if (m[0] === '') {
      re.lastIndex++
      continue
    }

    // Unmatched alternatives really are undefined at runtime; the lib type
    // claims plain string, so widen before testing which branch fired.
    const g: Array<string | undefined> = m
    const end = m.index + m[0].length

    // `snake_case_ident` must not become emphasis. Leaving `last` untouched
    // folds the match back into the surrounding plain text.
    if (
      (g[8] !== undefined || g[11] !== undefined) &&
      (isWordChar(src[m.index - 1]) || isWordChar(src[end]))
    ) {
      continue
    }

    if (m.index > last) out.push(src.slice(last, m.index))
    const key = `${kp}-x${n++}`

    const strong = g[7] ?? g[8]
    const emphasis = g[10] ?? g[11]
    const url = g[12] ?? g[13]

    if (g[1] !== undefined) {
      out.push(
        <code key={key} className="md-inline-code">
          {g[2]}
        </code>
      )
    } else if (g[3] !== undefined) {
      out.push(<InlineImage key={key} alt={g[3]} src={g[4] ?? ''} />)
    } else if (g[5] !== undefined) {
      const href = g[6] ?? ''
      out.push(
        <ExternalLink key={key} href={href}>
          {g[5] === '' ? href : renderInline(g[5], key)}
        </ExternalLink>
      )
    } else if (strong !== undefined) {
      out.push(<strong key={key}>{renderInline(strong, key)}</strong>)
    } else if (g[9] !== undefined) {
      out.push(<del key={key}>{renderInline(g[9], key)}</del>)
    } else if (emphasis !== undefined) {
      out.push(<em key={key}>{renderInline(emphasis, key)}</em>)
    } else if (url !== undefined) {
      out.push(
        <ExternalLink key={key} href={url}>
          {url}
        </ExternalLink>
      )
    }

    last = end
  }

  if (last < src.length) out.push(src.slice(last))
  return out
}

/** Links leave the app rather than navigating the renderer window. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        void window.harness.invoke('artifacts:open', href)
      }}
    >
      {children}
    </a>
  )
}

function InlineImage({ alt, src }: { alt: string; src: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) {
    return (
      <ExternalLink href={src}>{alt === '' ? src : alt}</ExternalLink>
    )
  }
  return <img className="md-img" src={src} alt={alt} onError={() => setBroken(true)} />
}
