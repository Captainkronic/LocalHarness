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

/**
 * `supportsVision` is an ADDITION TO THE SPEC's signature. Whether an image can
 * go on the wire is a property of the model, not of the conversation, and the
 * caller is the only one holding the `ModelInfo`. When it is false every image
 * attachment is replaced by a text note naming the file, so a text-only model
 * never receives a payload it cannot read.
 */
export function buildMessages(
  conv: Conversation,
  systemPrompt: string,
  supportsVision: boolean
): WireMessage[] {
  const out: WireMessage[] = []
  if (systemPrompt.trim().length > 0) {
    out.push({ role: 'system', content: systemPrompt })
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

  for (const msg of conv.messages) {
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
            function: { name: c.name, arguments: c.arguments.trim() || '{}' }
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

  return out
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

  const used = system + tools + messages + attachments
  const max = args.max !== null && args.max > 0 ? args.max : null

  return {
    used,
    max,
    breakdown: { system, tools, messages, attachments },
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
