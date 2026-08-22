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
    `[CaptainLlama removed ${length} characters of "${field}" from this transcript ` +
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
    out.push({
      role: 'system',
      content: `${systemPrompt}\n\n${todayLine()}${where === '' ? '' : `\n${where}`}`
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
