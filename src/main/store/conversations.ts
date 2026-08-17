/**
 * Conversation persistence: one JSON file per conversation under
 * `<userData>/conversations/`, all of them held in memory so `list()` and
 * `get()` are synchronous.
 *
 * Writes are best-effort: `save()` is called from the streaming turn loop, so a
 * disk error is logged and swallowed rather than allowed to kill a turn.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type {
  Attachment,
  ChatMessage,
  Conversation,
  ConversationSummary,
  MessageRole,
  ToolCall,
  TurnMetrics,
  WorkflowId
} from '@shared/types'
import { DEFAULT_WORKFLOW, WORKFLOW_BY_ID } from '@shared/workflows'

import { atomicWriteSync, expandTilde } from './paths'

/** Placeholder title; a conversation still carrying it gets a title derived
 *  from its first user message on the next save. */
const NEW_CONVERSATION_TITLE = 'New conversation'
const TITLE_LENGTH = 48
const MAX_TITLE_LENGTH = 200

const ROLES: readonly MessageRole[] = ['system', 'user', 'assistant', 'tool']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** Ids become filenames, so anything that could escape the directory is out. */
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..'
}

function isWorkflowId(v: unknown): v is WorkflowId {
  return typeof v === 'string' && v in WORKFLOW_BY_ID
}

function deriveTitle(conv: Conversation): string | null {
  const first = conv.messages.find((m) => m.role === 'user' && m.content.trim().length > 0)
  if (!first) return null
  const flattened = first.content.replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return null
  return flattened.slice(0, TITLE_LENGTH).trimEnd()
}

/**
 * Structural relay for values this app wrote itself (tool calls, attachments,
 * metrics). They are checked for shape, not field by field — re-validating every
 * nested field would only turn our own output into a second schema to maintain.
 */
function asRecordArray<T>(v: unknown): T[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter(isRecord) as unknown as T[]
}

function normalizeMessage(raw: unknown): ChatMessage | null {
  if (!isRecord(raw)) return null
  const role = raw.role
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) return null

  const msg: ChatMessage = {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : randomUUID(),
    role: role as MessageRole,
    content: typeof raw.content === 'string' ? raw.content : '',
    createdAt: asFiniteNumber(raw.createdAt) ?? Date.now()
  }

  if (typeof raw.reasoning === 'string') msg.reasoning = raw.reasoning
  if (typeof raw.toolCallId === 'string') msg.toolCallId = raw.toolCallId
  if (typeof raw.error === 'string') msg.error = raw.error

  const toolCalls = asRecordArray<ToolCall>(raw.toolCalls)
  if (toolCalls && toolCalls.length > 0) msg.toolCalls = toolCalls

  const attachments = asRecordArray<Attachment>(raw.attachments)
  if (attachments && attachments.length > 0) msg.attachments = attachments

  if (isRecord(raw.metrics)) msg.metrics = raw.metrics as unknown as TurnMetrics

  // `streaming` is deliberately dropped: a conversation persisted mid-turn would
  // otherwise come back from disk with a spinner that never stops.
  return msg
}

function normalizeConversation(raw: unknown, fallbackId: string): Conversation | null {
  if (!isRecord(raw)) return null

  const id = isSafeId(raw.id) ? raw.id : fallbackId
  if (!isSafeId(id)) return null

  const createdAt = asFiniteNumber(raw.createdAt) ?? Date.now()
  const title =
    typeof raw.title === 'string' && raw.title.trim().length > 0
      ? raw.title.slice(0, MAX_TITLE_LENGTH)
      : NEW_CONVERSATION_TITLE

  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter((m): m is ChatMessage => m !== null)
    : []

  const conv: Conversation = {
    id,
    title,
    workflowId: isWorkflowId(raw.workflowId) ? raw.workflowId : DEFAULT_WORKFLOW,
    messages,
    modelId: typeof raw.modelId === 'string' && raw.modelId.length > 0 ? raw.modelId : null,
    createdAt,
    updatedAt: asFiniteNumber(raw.updatedAt) ?? createdAt
  }

  if (isRecord(raw.mcpOverrides)) {
    const overrides: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(raw.mcpOverrides)) {
      if (typeof value === 'boolean') overrides[key] = value
    }
    conv.mcpOverrides = overrides
  }

  return conv
}

export class ConversationStore {
  private readonly dir: string
  private readonly cache = new Map<string, Conversation>()

  /** @param dir the app's userData directory; files live in `<dir>/conversations`. */
  constructor(dir: string) {
    this.dir = join(expandTilde(dir), 'conversations')
    this.loadAll()
  }

  list(): ConversationSummary[] {
    return [...this.cache.values()]
      .map((c) => ({
        id: c.id,
        title: c.title,
        workflowId: c.workflowId,
        messageCount: c.messages.length,
        updatedAt: c.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Conversation | null {
    return this.cache.get(id) ?? null
  }

  create(workflowId: WorkflowId): Conversation {
    const now = Date.now()
    const conv: Conversation = {
      id: randomUUID(),
      title: NEW_CONVERSATION_TITLE,
      workflowId: isWorkflowId(workflowId) ? workflowId : DEFAULT_WORKFLOW,
      messages: [],
      modelId: null,
      createdAt: now,
      updatedAt: now
    }
    this.cache.set(conv.id, conv)
    this.write(conv)
    return conv
  }

  /**
   * Persists `c` and takes ownership of it as the cached instance — the object
   * passed in is the object `get()` will hand back, so a caller streaming into
   * it keeps seeing its own edits. `updatedAt` and an auto-derived title are
   * written onto it in place.
   */
  save(c: Conversation): void {
    if (!isSafeId(c.id)) {
      console.warn('[conversations] refusing to save conversation with unsafe id')
      return
    }
    if (c.title === NEW_CONVERSATION_TITLE) {
      const derived = deriveTitle(c)
      if (derived) c.title = derived
    }
    c.updatedAt = Date.now()
    this.cache.set(c.id, c)
    this.write(c)
  }

  delete(id: string): void {
    this.cache.delete(id)
    if (!isSafeId(id)) return
    try {
      unlinkSync(this.fileFor(id))
    } catch {
      /* already gone, or never written */
    }
  }

  rename(id: string, title: string): void {
    const conv = this.cache.get(id)
    if (!conv) return
    const trimmed = typeof title === 'string' ? title.trim() : ''
    conv.title = trimmed.length > 0 ? trimmed.slice(0, MAX_TITLE_LENGTH) : NEW_CONVERSATION_TITLE
    conv.updatedAt = Date.now()
    this.write(conv)
  }

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private write(conv: Conversation): void {
    try {
      atomicWriteSync(this.fileFor(conv.id), JSON.stringify(conv, null, 2))
    } catch (err) {
      console.warn('[conversations] failed to write', conv.id, err)
    }
  }

  private loadAll(): void {
    let entries: string[]
    try {
      mkdirSync(this.dir, { recursive: true })
      entries = readdirSync(this.dir)
    } catch (err) {
      console.warn('[conversations] cannot read', this.dir, err)
      return
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue // skips leftover .tmp files
      try {
        const raw: unknown = JSON.parse(readFileSync(join(this.dir, entry), 'utf8'))
        const conv = normalizeConversation(raw, entry.slice(0, -'.json'.length))
        if (conv) this.cache.set(conv.id, conv)
      } catch (err) {
        console.warn('[conversations] skipping unreadable file', entry, err)
      }
    }
  }
}
