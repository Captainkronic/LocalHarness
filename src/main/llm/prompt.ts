/**
 * Prompt assembly and context accounting.
 *
 * Turns a stored `Conversation` into the wire messages the model actually sees,
 * and reports where the context window is going. Both halves are estimates and
 * the UI labels them as such — nothing here tokenises for real.
 */

import type {
  Attachment,
  ChatMessage,
  ContextUsage,
  Conversation,
  ToolCall,
  WireTool
} from '@shared/types'
import { ELIDED_MARK } from '@shared/types'
import { WIRE_IMAGE_MIMES } from '@shared/types'
import { estimateTokens, toolSchemaTokens } from '@main/mcp/tokens'
import type { WireMessage } from './client'

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

/** Per-message framing the chat template adds (role markers, separators). */
const PER_MESSAGE_OVERHEAD_TOKENS = 4
/**
 * Flat cost charged for one image part. Real vision cost depends on the tile
 * grid the model chops the image into; the base64 length is a wildly wrong
 * proxy for it, so a single honest constant beats a precise-looking lie.
 */
const IMAGE_PART_TOKENS = 1024

/** Headroom for the "earlier messages were dropped" marker, which is written
 *  after the budget maths has already been done. */
const MARKER_RESERVE_TOKENS = 64

/**
 * `supportsVision` is an ADDITION TO THE SPEC's signature. Whether an image can
 * go on the wire is a property of the model, not of the conversation, and the
 * caller is the only one holding the `ModelInfo`. When it is false every image
 * attachment is replaced by a text note naming the file, so a text-only model
 * never receives a payload it cannot read.
 */
/** What was dropped to fit the window, for the UI and the log. */
export interface TrimInfo {
  /** Wire messages removed. */
  messages: number
  /** Their estimated token cost. */
  tokens: number
  /** Wire messages that survived, excluding the marker. */
  kept: number
}

export interface BuildOptions {
  /**
   * Token ceiling for the whole message list. Omit for no trimming, which is
   * what `contextUsage` wants — it is measuring the untrimmed truth.
   */
  budget?: number
  /** Called only when something was actually dropped. */
  onTrim?: (info: TrimInfo) => void
  /**
   * The sandbox folders, named in the system prompt so the model does not have
   * to discover or invent them. See `workspaceLine`.
   */
  workspaceRoots?: string[]
}

/**
 * Where the model is allowed to work, stated rather than discovered.
 *
 * The sandbox refuses anything outside these folders, and the refusal message
 * is good — but until this existed the model was never TOLD the path, so it
 * guessed. Across one day of agentic runs it invented `/Users/adam/workspace`,
 * `/outputs/mini-golf-3d` and `/Users/adam/flight-sim`, each costing a refused
 * call and a round trip through a 27B model at ~18 tok/s before it fell back to
 * list_dir to find out where it actually was.
 *
 * A dozen tokens at the top of the prompt removes the whole class. It also
 * gives relative paths a stated meaning, which is the other half of the same
 * problem: `minigolf/game.js` resolved under the workspace root and missed, and
 * nothing in the prompt said what it would be resolved against.
 */
/**
 * What this conversation has already written, as a list the model can read.
 *
 * The single biggest waste of thinking measured on a live agentic build was the
 * model recovering state the app already had. Three verbatim examples from one
 * run:
 *
 *   "I'm not sure what I wrote in index.html. The transcript was truncated."
 *   "on disk it's 1 line, 323 bytes. That doesn't add up."
 *   "something in the pipeline (context compression of my own output?)
 *    replaced it."
 *
 * The first of those produced a real content defect — index.html said one town
 * name and data.js another, because it could not see what it had written — and
 * then cost further thinking to notice and blame. Across 33 reasoning blocks,
 * 21% went on re-reading its own work and 18% on uncertainty about its own
 * state.
 *
 * Bulk arguments are elided from history for good reasons that have not
 * changed. But eliding the CONTENT does not require eliding the FACT: the app
 * knows every path written, how big each one is, and whether the write
 * verified. That costs a couple of hundred tokens to state and removes a class
 * of doubt that costs whole re-prefills to resolve.
 *
 * Sizes, not contents. This is a map, not a cache — enough to know the file
 * exists and roughly what shape it is, so the decision to read it back is made
 * on evidence rather than on anxiety.
 */
export function writtenFilesLine(messages: readonly ChatMessage[]): string {
  const seen = new Map<string, { lines: number; bytes: number; shape: string }>()
  for (const msg of messages) {
    for (const call of msg.toolCalls ?? []) {
      if (call.name !== 'write_file' && call.name !== 'edit_file') continue
      if (call.status !== 'ok') continue
      let path: string | undefined
      try {
        const args: unknown = JSON.parse(call.arguments)
        if (typeof args === 'object' && args !== null && 'path' in args) {
          const p = (args as { path: unknown }).path
          if (typeof p === 'string' && p.trim() !== '') path = p.trim()
        }
      } catch {
        continue
      }
      if (path === undefined) continue
      const result = call.result ?? ''
      const lines = Number(/\((\d+) lines\)/.exec(result)?.[1] ?? 0)
      const bytes = sizeFromResult(result)
      const prev = seen.get(path)
      /* The content is still on the ToolCall — elision only rewrites the copy
         that goes on the wire — so the shape can be read without touching disk
         and without a second source of truth to fall out of date. */
      const shape = shapeOf(path, contentOf(call)) || (prev?.shape ?? '')
      seen.set(path, {
        lines: lines > 0 ? lines : (prev?.lines ?? 0),
        bytes: bytes > 0 ? bytes : (prev?.bytes ?? 0),
        shape
      })
    }
  }
  if (seen.size === 0) return ''

  const rows = [...seen.entries()].map(([path, f]) => {
    const size = f.bytes > 0 ? `${(f.bytes / 1024).toFixed(1)} kB` : f.lines > 0 ? `${f.lines} lines` : 'written'
    return `  ${path} — ${size}${f.shape === '' ? '' : `\n      ${f.shape}`}`
  })
  return (
    `Files you have already written in this conversation, with their size and what they define:\n` +
    `${rows.join('\n')}\n` +
    `This list is the app's own record, not your memory of it. If a file is here it exists and ` +
    `is that size, whatever your earlier messages look like — their contents are trimmed out of ` +
    `the transcript to save room. Read one back only when you need its exact text; do not read ` +
    `it back to find out whether it worked.`
  )
}

/** The content that was written, from the call that wrote it. */
function contentOf(call: { arguments: string }): string {
  try {
    const a: unknown = JSON.parse(call.arguments)
    if (typeof a !== 'object' || a === null) return ''
    const v = (a as Record<string, unknown>).content ?? (a as Record<string, unknown>).new_string
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/**
 * The names a file defines, so the model does not have to read it to find out.
 *
 * Measured on a live build: twelve consecutive read-only turns and about ninety
 * minutes spent rediscovering that Home.jsx imported `leadTime` while data.js
 * exported `leadTimeFor`, that piece ids "p1"/"w1"/"c1" did not exist, and that
 * `.hero__glow` was referenced by a component and absent from the stylesheet.
 * Every one of those is a NAME, and the app had the text that defines them.
 *
 * Names only, and capped. This is a index, not a copy — enough to spell an
 * import correctly, not enough to reason about behaviour, because a file whose
 * behaviour matters should still be read.
 */
function shapeOf(path: string, content: string): string {
  if (content === '') return ''
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  const names: string[] = []
  const push = (n: string | undefined): void => {
    if (n !== undefined && n !== '' && !names.includes(n)) names.push(n)
  }

  if (/^\.(jsx?|tsx?|mjs|cjs)$/.test(ext)) {
    for (const m of content.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) push(m[1])
    for (const m of content.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) push(m[1])
    for (const m of content.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of (m[1] ?? '').split(',')) push(part.split(/\s+as\s+/)[0]?.trim())
    }
    if (/export\s+default/.test(content)) push('default')
    if (names.length === 0) return ''
    return `exports: ${cap(names)}`
  }

  if (ext === '.css') {
    for (const m of content.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) push(m[1])
    if (names.length === 0) return ''
    return `classes: ${cap(names)}`
  }

  return ''
}

/** Enough to be useful, not enough to become the prompt. */
function cap(names: string[]): string {
  const MAX = 14
  return names.length <= MAX
    ? names.join(', ')
    : `${names.slice(0, MAX).join(', ')} … +${names.length - MAX} more`
}

/** "8.0 KB on disk, verified." / "4.4 kB" — whichever the executor phrased. */
function sizeFromResult(result: string): number {
  const m = /([\d.]+)\s*(B|kB|KB|MB)\b/.exec(result)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2].toLowerCase()
  return unit === 'b' ? n : unit === 'mb' ? n * 1024 * 1024 : n * 1024
}

export function workspaceLine(roots: string[]): string {
  if (roots.length === 0) return ''
  if (roots.length === 1) {
    return (
      `Your workspace is ${roots[0]}. That is the only folder you can read or write, ` +
      `and a relative path is resolved against it. Do not guess at other paths.`
    )
  }
  return (
    `Your workspace folders are ${roots.map((r) => `${r}`).join(', ')}. Those are the only ` +
    `folders you can read or write, and a relative path is resolved against the first. ` +
    `Do not guess at other paths.`
  )
}

/** e.g. "Today is Tuesday, 18 August 2026." — the model's only clock. */
export function todayLine(now: Date = new Date()): string {
  return `Today is ${now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  })}.`
}

/**
 * Fields whose value is a payload rather than an instruction.
 *
 * These are what a coding turn puts a whole file into, and once written they are
 * on disk — replaying them is paying to tell the model something it can read.
 */
const BULK_FIELDS = new Set(['content', 'new_string', 'old_string', 'text', 'body'])

/**
 * Beyond this a value is a payload, not an argument.
 *
 * The floor also has to clear the marker that replaces the value. The marker
 * below is deliberately wordy — it has an hour of wasted run time to argue
 * against — so eliding a 700-character value would save almost nothing while
 * still costing the model the text. Above 1200 the saving is always real, and
 * edits small enough to stay legible in the transcript now stay whole.
 */
const BULK_LIMIT = 1200

/**
 * What the model sees where its own payload used to be.
 *
 * The first version of this read `<8102 characters, already applied — read the
 * file if you need them>`, and on a live React build the model hit it and
 * concluded the harness was corrupting its writes:
 *
 *   "did I write <8102 characters...> as the actual content?? ... it seems like
 *    something got truncated in transit"
 *
 * It spent the next fifty messages on that theory — re-reading files that were
 * already correct, capping itself at "keep each write under about 2KB", and
 * splitting finished stylesheets in half to stay under a limit that did not
 * exist. Every write in that run had verified clean on disk.
 *
 * Three things caused it, and all three are addressed here. Angle brackets read
 * as a placeholder token, so the marker looked like the truncation rather than a
 * note about it — square brackets read as an editorial aside. "Already applied"
 * never says applied BY WHAT, leaving the transport as the natural suspect — so
 * the harness now names itself as the actor. And nothing told the model the
 * bytes on disk were fine, which was the one fact that would have ended it — so
 * that is now stated outright, before the instruction to go and look.
 */
function markElided(field: string, length: number): string {
  return (
    `${ELIDED_MARK}${length} characters of "${field}" from this transcript ` +
    'to save context. The tool received the full value and applied all of it — nothing ' +
    'was truncated, and the file on disk is complete. This affects only what you are ' +
    'reading back here, never what was written. Call read_file to see the current contents.]'
  )
}

/**
 * Replaces bulk argument values in REPLAYED tool calls with a note of their size.
 *
 * Measured on a Tetris build: the model wrote a complete 12.8KB index.html on
 * its second turn, and every turn after that re-sent those 12.8KB as part of the
 * assistant message that made the call. Turn 3 waited 24.9s for its first token
 * and 5.7 minutes overall, and the cost compounded with each further edit. The
 * file was on disk the whole time.
 *
 * Only the HISTORY is elided. The call as issued is untouched, the tool ran on
 * the real arguments, and the result the model saw is unchanged — this affects
 * nothing except what gets re-read on later turns. The marker says what was
 * there and what to do about it, because a silently truncated argument would
 * teach the model it had written a short file.
 */
export function elideBulkArguments(raw: string): string {
  if (raw.length <= BULK_LIMIT) return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not parseable — a fragment from a cut-off turn. Left exactly as it is:
    // rewriting it blind risks making it less recoverable, not more.
    return raw
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return raw

  let touched = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (BULK_FIELDS.has(key) && typeof value === 'string' && value.length > BULK_LIMIT) {
      out[key] = markElided(key, value.length)
      touched = true
    } else {
      out[key] = value
    }
  }
  return touched ? JSON.stringify(out) : raw
}

export function buildMessages(
  conv: Conversation,
  systemPrompt: string,
  supportsVision: boolean,
  opts: BuildOptions = {}
): WireMessage[] {
  const out: WireMessage[] = []
  if (systemPrompt.trim().length > 0) {
    // Today's date, appended to every system prompt.
    //
    // A model has no clock. Left to itself it answers "next Friday" from its
    // training cutoff, which is silently months or years wrong — and wrong in a
    // way that looks authoritative. That matters anywhere a date is computed
    // rather than quoted: booking a flight, "how long until", "is that still
    // current". Roughly a dozen tokens, and it removes a whole class of
    // confident nonsense.
    const where = workspaceLine(opts.workspaceRoots ?? [])
    /* Rebuilt every request rather than accumulated, so a file written this
       turn appears immediately and nothing has to be invalidated. */
    const written = writtenFilesLine(conv.messages)
    out.push({
      role: 'system',
      content:
        `${systemPrompt}\n\n${todayLine()}` +
        `${where === '' ? '' : `\n${where}`}` +
        `${written === '' ? '' : `\n\n${written}`}`
    })
  }

  // Tool results the conversation stores as their own messages. Results held on
  // the assistant's ToolCall objects are only synthesised when they are missing
  // here, so a conversation that records both does not emit each result twice.
  const explicitResultIds = new Set<string>()
  for (const msg of conv.messages) {
    if (msg.role === 'tool' && typeof msg.toolCallId === 'string') {
      explicitResultIds.add(msg.toolCallId)
    }
  }

  /*
   * The newest tool-calling message keeps its bulk arguments.
   *
   * Eliding everything is right for history and wrong for the turn that just
   * happened: the model writes a file and, on its very next step, wants to know
   * what is in it. Watched live — "the index.html I wrote, let me check what's
   * in it (it was truncated in the transcript), I'll read it back" — and that
   * read cost a full re-prefill of a 22k-token conversation, about a minute, to
   * recover text the app had deliberately thrown away one step earlier.
   *
   * One step of grace is the whole fix. Keeping a 22 KB write costs ~5.5k
   * tokens for a single turn; re-reading it costs the entire prompt again plus
   * the file a second time. Keeping it FOREVER is the original bug this elision
   * was written for — a 12.8 KB index.html re-sent on every turn for the rest
   * of the build — and one step does not reintroduce it.
   */
  let lastUserIdx = -1
  let newestCallIdx = -1
  conv.messages.forEach((m, i) => {
    if (m.role === 'user') lastUserIdx = i
    if (m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0) newestCallIdx = i
  })
  /* Only within the CURRENT turn. "Newest tool call" alone was not a boundary:
     a conversation that ends with a big write and then carries on in chat would
     keep re-sending it for the rest of its life, which is precisely the bug the
     elision exists to prevent. A new user message ends the grace. */
  const keepIntactIdx = newestCallIdx > lastUserIdx ? newestCallIdx : -1

  for (const [msgIdx, msg] of conv.messages.entries()) {
    switch (msg.role) {
      case 'system':
        if (msg.content.trim().length > 0) {
          out.push({ role: 'system', content: msg.content })
        }
        break

      case 'user':
        out.push({ role: 'user', content: userContent(msg, supportsVision) })
        break

      case 'assistant': {
        const calls = (msg.toolCalls ?? []).filter(
          (c) => c.id.length > 0 && c.name.length > 0
        )
        if (msg.content.trim().length === 0 && calls.length === 0) break

        const wire: WireMessage = { role: 'assistant', content: msg.content }
        if (calls.length > 0) {
          wire.tool_calls = calls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            // Arguments can still be a partial JSON fragment if the turn was cut
            // short; an empty object keeps the history parseable.
            function: {
              name: c.name,
              arguments:
                msgIdx === keepIntactIdx
                  ? c.arguments.trim() || '{}'
                  : elideBulkArguments(c.arguments.trim() || '{}')
            }
          }))
        }
        out.push(wire)

        // Every tool_call id must be answered or the next request is rejected.
        for (const call of calls) {
          if (explicitResultIds.has(call.id)) continue
          out.push({
            role: 'tool',
            tool_call_id: call.id,
            content: toolResultText(call)
          })
        }
        break
      }

      case 'tool':
        if (typeof msg.toolCallId === 'string' && msg.toolCallId.length > 0) {
          out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.content })
        }
        break
    }
  }

  return opts.budget === undefined ? out : trimToBudget(out, opts.budget, opts.onTrim)
}

/**
 * Drops the oldest exchanges until the list fits, and says so in the prompt.
 *
 * Three rules, and all three are load-bearing:
 *
 * 1. System messages are never dropped. They are the workflow's identity, and a
 *    JARVIS that forgets it is JARVIS is not a smaller context, it is a
 *    different assistant.
 * 2. An assistant message carrying `tool_calls` and the `tool` replies that
 *    answer it move together, always. Splitting them is the exact corruption
 *    that a late tool result caused in the Live loop — the request is rejected
 *    outright, so trimming that "worked" would break every later turn.
 * 3. The newest exchange is never dropped. Trimming away the question being
 *    asked leaves the model answering the one before it.
 *
 * Oldest-first rather than summarised, deliberately. A summary costs a
 * round-trip on the inference box and quietly loses the specifics a coding
 * session needs later — an exact path, an error string. Dropping is lossy in a
 * way the user can SEE, and a visible loss beats an invisible one.
 */
export function trimToBudget(
  messages: WireMessage[],
  budget: number,
  onTrim?: (info: TrimInfo) => void
): WireMessage[] {
  if (budget <= 0) return messages
  if (countConversationTokens(messages) <= budget) return messages

  // Leading system messages are fixed cost; everything after them is history.
  let head = 0
  while (head < messages.length && messages[head].role === 'system') head++
  const system = messages.slice(0, head)
  const groups = groupExchanges(messages.slice(head))
  if (groups.length <= 1) return messages

  /*
   * The first user message is never dropped. It is the task.
   *
   * Trimming kept the newest groups walking backwards, which on an agentic run
   * eventually reaches the oldest message — and on an agentic run the oldest
   * message is the brief, because everything after it is the model talking to
   * itself. Measured here: a 32-request build, one user message, and at 79% of
   * the window the trimmer dropped it. The server then refused the request
   * outright — "Chat template error: No user query found in messages" — and
   * every retry re-trimmed and re-dropped it, so the turn could not recover at
   * all. An hour of work, ended by losing the sentence that started it.
   *
   * It is also the cheapest thing in the conversation to keep. A brief is a
   * paragraph; the tool results around it are tens of kilobytes.
   */
  const anchorIdx = groups.findIndex((g) => g[0]?.role === 'user')
  const anchor = anchorIdx === -1 ? [] : groups[anchorIdx]

  const marker: WireMessage = { role: 'system', content: '' }
  const fixed = countConversationTokens(system) + countConversationTokens(anchor)

  // Keep the newest groups, walking backwards, and always keep at least one.
  const kept: WireMessage[][] = []
  let total = fixed + PER_MESSAGE_OVERHEAD_TOKENS + MARKER_RESERVE_TOKENS
  for (let i = groups.length - 1; i >= 0; i--) {
    if (i === anchorIdx) continue // already counted in `fixed`, and always kept
    const cost = countConversationTokens(groups[i])
    if (kept.length > 0 && total + cost > budget) break
    kept.unshift(groups[i])
    total += cost
  }

  const keptSet = new Set(kept)
  const droppedGroups = groups.filter((g, i) => i !== anchorIdx && !keptSet.has(g))
  if (droppedGroups.length === 0) return messages

  const droppedMessages = droppedGroups.reduce((n, g) => n + g.length, 0)
  const droppedTokens = droppedGroups.reduce((n, g) => n + countConversationTokens(g), 0)

  // Said in the prompt, not just in the UI. A model that cannot see the start of
  // the conversation should know that is why, rather than infer that it never
  // happened — otherwise it answers confidently about a thread it cannot read.
  marker.content =
    `[${droppedMessages} earlier message${droppedMessages === 1 ? '' : 's'} ` +
    `were dropped from this conversation to fit the context window. ` +
    `If the user refers to something you cannot see, say so and ask them to repeat it ` +
    `rather than guessing at what it was.]`

  /* `kept` means "messages the model can still see", so the pinned brief counts
     — it is in the output. Reporting the eviction-walk total instead made this
     disagree with what was actually sent, by exactly one. */
  onTrim?.({
    messages: droppedMessages,
    tokens: droppedTokens,
    kept: kept.flat().length + anchor.length
  })
  /* Brief first, then the note about what went missing, then what survived —
     so the model reads the task before it reads the apology. */
  return [...system, ...anchor, marker, ...kept.flat()]
}

/**
 * Splits history into units that must move together.
 *
 * A `tool` message belongs to the assistant message before it. Anything else
 * starts a new group.
 */
function groupExchanges(messages: WireMessage[]): WireMessage[][] {
  const groups: WireMessage[][] = []
  for (const msg of messages) {
    if (msg.role === 'tool' && groups.length > 0) {
      groups[groups.length - 1].push(msg)
    } else {
      groups.push([msg])
    }
  }
  return groups
}

export function countConversationTokens(msgs: WireMessage[]): number {
  let total = 0
  for (const msg of msgs) {
    total += PER_MESSAGE_OVERHEAD_TOKENS
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else {
      for (const part of msg.content) {
        total += part.type === 'text' ? estimateTokens(part.text) : IMAGE_PART_TOKENS
      }
    }
    for (const call of msg.tool_calls ?? []) {
      total +=
        PER_MESSAGE_OVERHEAD_TOKENS +
        estimateTokens(call.function.name) +
        estimateTokens(call.function.arguments)
    }
    if (msg.tool_call_id !== undefined) {
      total += estimateTokens(msg.tool_call_id)
    }
  }
  return total
}

/**
 * The four buckets are disjoint by construction: `system` messages and image
 * parts are excluded from the `messages` count because they are already counted
 * as `system` and `attachments`. Pass every attachment currently in the window,
 * not just the new ones, or images will be undercounted.
 */
export function buildContextUsage(args: {
  system: string
  tools: WireTool[]
  messages: WireMessage[]
  attachments: Attachment[]
  max: number | null
  /**
   * Measured actual-prompt-tokens / our-estimate for this model, or 1 when
   * nothing has been measured yet.
   *
   * Without this the meter reads low, and it reads low in the direction that
   * looks safe. Caught live at 126 minutes into an autonomous React build: the
   * header said 22.7k of 98.3k (23%) while the server had just reported 29.3k
   * for the same conversation — a 29% understatement on the one number a user
   * consults to decide whether there is room left. The ratio was already being
   * learned and was already applied to the history budget; it simply never
   * reached the display, so the internal accounting and the visible accounting
   * had quietly diverged.
   */
  ratio?: number
}): ContextUsage {
  const system = estimateTokens(args.system)

  let tools = 0
  for (const tool of args.tools) {
    tools += toolSchemaTokens(
      tool.function.name,
      tool.function.description,
      tool.function.parameters
    )
  }

  let attachments = 0
  for (const attachment of args.attachments) {
    attachments += Math.max(0, Math.round(attachment.tokens))
  }

  const conversational = args.messages
    .filter((m) => m.role !== 'system')
    .map(stripImageParts)
  const messages = countConversationTokens(conversational)

  /* Attachments are deliberately NOT scaled. The ratio is learned against a
     character estimate of text and tool schemas; attachment figures are real
     per-image token counts, already exact, and multiplying them by a text
     correction would corrupt a number that was right. */
  const r = args.ratio !== undefined && args.ratio > 0 ? args.ratio : 1
  const scale = (n: number): number => Math.round(n * r)
  const scaled = {
    system: scale(system),
    tools: scale(tools),
    messages: scale(messages),
    attachments
  }

  const used = scaled.system + scaled.tools + scaled.messages + scaled.attachments
  const max = args.max !== null && args.max > 0 ? args.max : null

  return {
    used,
    max,
    calibrated: r !== 1,
    breakdown: scaled,
    fraction: max === null ? null : used / max
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function userContent(msg: ChatMessage, supportsVision: boolean): WireMessage['content'] {
  const attachments = msg.attachments ?? []
  if (attachments.length === 0) return msg.content

  const notes: string[] = []
  const images: ContentPart[] = []

  for (const attachment of attachments) {
    if (attachment.kind !== 'image') {
      notes.push(`[attached file: ${attachment.name} — ${attachment.path}]`)
      continue
    }
    if (!supportsVision) {
      notes.push(
        `[image not shown: ${attachment.name} — ${attachment.path} — the active model has no vision capability]`
      )
      continue
    }
    if (attachment.dataUrl === undefined || attachment.dataUrl.length === 0) {
      // A file:// URL is not fetchable by the server, so name it instead of
      // putting something broken on the wire.
      notes.push(`[image unavailable: ${attachment.name} — ${attachment.path}]`)
      continue
    }
    /*
     * The last gate before the wire, and it exists because history repeats.
     *
     * Every request replays the whole conversation, attachments included — so
     * ONE image the server refuses does not fail one turn, it fails every turn
     * after it, forever. That is what it looked like: a webp 400'd, and then a
     * perfectly good PNG 400'd too, because the webp was still in the history
     * behind it. The conversation was permanently unusable and nothing on
     * screen said why.
     *
     * Attachments picked from now on are converted when they are picked, but
     * ones already stored cannot be, so an unsendable format is dropped with a
     * note. Losing one image is a bad turn; sending it is a dead conversation.
     */
    const mime = attachment.dataUrl.slice(5, attachment.dataUrl.indexOf(';'))
    if (!WIRE_IMAGE_MIMES.includes(mime)) {
      notes.push(
        `[image not sent: ${attachment.name} — the inference server does not accept ` +
          `${mime}. Attach it again and it will be converted automatically.]`
      )
      continue
    }
    images.push({ type: 'image_url', image_url: { url: attachment.dataUrl } })
  }

  const text = [msg.content, ...notes].filter((t) => t.trim().length > 0).join('\n')
  if (images.length === 0) return text

  const parts: ContentPart[] = []
  if (text.length > 0) parts.push({ type: 'text', text })
  parts.push(...images)
  return parts
}

function toolResultText(call: ToolCall): string {
  if (call.result !== undefined && call.result.length > 0) return call.result
  if (call.error !== undefined && call.error.length > 0) return `Error: ${call.error}`
  if (call.status === 'denied') return 'The user denied this tool call.'
  return `No result was recorded for this tool call (status: ${call.status}).`
}

function stripImageParts(msg: WireMessage): WireMessage {
  if (typeof msg.content === 'string') return msg
  const textOnly = msg.content.filter(
    (part): part is { type: 'text'; text: string } => part.type === 'text'
  )
  return { ...msg, content: textOnly }
}
