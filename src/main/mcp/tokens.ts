/**
 * Token estimation and JSON-Schema sanitising for MCP tool payloads.
 *
 * Both jobs exist for the same reason: the model on the other end is a local
 * one. Token counts drive the prefill budget readout (prefill is the expensive
 * half of a local turn), and the sanitiser mirrors the LM Studio sanitising
 * proxy — several Gemma chat templates throw when a tool schema carries `enum`
 * or `anyOf`, and a type-less node renders as `undefined` in the prompt.
 */

import type { JsonSchema } from '@shared/types'

/** Bytes-per-token for a rough char-based estimate. Labelled as an estimate in the UI. */
const CHARS_PER_TOKEN = 4

/**
 * Per-tool wire overhead beyond the JSON we count: the `{"type":"function",
 * "function":{...}}` envelope plus the separators the template puts around it.
 */
const TOOL_PROTOCOL_OVERHEAD = 8

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Cost of one tool as the model sees it: name + description + parameter schema,
 * plus the fixed envelope overhead.
 */
export function toolSchemaTokens(
  name: string,
  description: string,
  schema: JsonSchema
): number {
  let payload: string
  try {
    payload = JSON.stringify({ name, description, parameters: schema })
  } catch {
    // Cyclic or otherwise unserialisable schema — fall back to the parts we can measure.
    payload = `${name}${description}`
  }
  return estimateTokens(payload) + TOOL_PROTOCOL_OVERHEAD
}

/* ------------------------------------------------------------------ */
/* Sanitising                                                          */
/* ------------------------------------------------------------------ */

/** Keys whose values are themselves schemas (single). */
const SCHEMA_VALUE_KEYS = ['items', 'additionalProperties', 'not', 'contains'] as const

/** Keys whose values are maps of name -> schema. */
const SCHEMA_MAP_KEYS = ['properties', 'definitions', '$defs', 'patternProperties'] as const

/**
 * Returns a sanitised deep copy. Pure: the input is never mutated.
 *
 * - `enum` is stripped and folded into the description as "Allowed values: …".
 * - `anyOf` / `oneOf` / `allOf` collapse to the first branch that declares a
 *   `type` (or the first branch at all, if none does).
 * - Any node left without a `type` gets one inferred, defaulting to `object`.
 */
export function sanitizeSchema(schema: JsonSchema): JsonSchema {
  const clone = cloneJson(schema)
  const sanitized = sanitizeNode(clone)
  return isRecord(sanitized) ? (sanitized as JsonSchema) : { type: 'object' }
}

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode)
  if (!isRecord(node)) return node

  let current: Record<string, unknown> = node

  // Collapse composition keywords before anything else, so the branch we adopt
  // is what the rest of the pass sees.
  current = collapseComposition(current)

  // enum -> description
  if (Array.isArray(current.enum)) {
    const values: unknown[] = current.enum
    delete current.enum
    const rendered = values.map(renderEnumValue).filter((v) => v.length > 0)
    if (rendered.length > 0) {
      const existing = typeof current.description === 'string' ? current.description : ''
      const note = `Allowed values: ${rendered.join(', ')}`
      current.description = existing ? `${existing.replace(/\s+$/, '')}. ${note}` : note
    }
    if (current.type === undefined) {
      const inferred = inferTypeFromValues(values)
      if (inferred) current.type = inferred
    }
  }

  // `const` has the same template problem as a one-value enum.
  if (current.const !== undefined) {
    const value = current.const
    delete current.const
    const existing = typeof current.description === 'string' ? current.description : ''
    const note = `Must be ${renderEnumValue(value)}`
    current.description = existing ? `${existing.replace(/\s+$/, '')}. ${note}` : note
    if (current.type === undefined) {
      const inferred = inferTypeFromValues([value])
      if (inferred) current.type = inferred
    }
  }

  for (const key of SCHEMA_MAP_KEYS) {
    const map = current[key]
    if (isRecord(map)) {
      const next: Record<string, unknown> = {}
      for (const [name, value] of Object.entries(map)) next[name] = sanitizeNode(value)
      current[key] = next
    }
  }

  for (const key of SCHEMA_VALUE_KEYS) {
    const value = current[key]
    // `additionalProperties: false` is a boolean, not a schema — leave it alone.
    if (isRecord(value) || Array.isArray(value)) current[key] = sanitizeNode(value)
  }

  if (Array.isArray(current.prefixItems)) {
    current.prefixItems = current.prefixItems.map(sanitizeNode)
  }

  if (current.type === undefined) current.type = inferTypeFromShape(current)

  return current
}

/**
 * Picks one branch out of anyOf/oneOf/allOf and merges it over the sibling
 * keywords. Sibling keys win only where the branch is silent, so a parent
 * `description` survives a branch that has none.
 */
function collapseComposition(node: Record<string, unknown>): Record<string, unknown> {
  const keys = ['anyOf', 'oneOf', 'allOf'] as const
  let current = node

  for (const key of keys) {
    const branches = current[key]
    if (!Array.isArray(branches) || branches.length === 0) {
      if (key in current) delete current[key]
      continue
    }
    const objectBranches = branches.filter(isRecord)
    if (objectBranches.length === 0) {
      delete current[key]
      continue
    }
    const chosen =
      objectBranches.find((b) => b.type !== undefined && b.type !== 'null') ??
      objectBranches[0]

    const rest: Record<string, unknown> = { ...current }
    delete rest[key]
    // Branch fields override the parent's; parent-only fields (description,
    // title, default) are kept.
    current = { ...rest, ...chosen }
  }

  return current
}

function inferTypeFromShape(node: Record<string, unknown>): string {
  if (isRecord(node.properties) || isRecord(node.patternProperties)) return 'object'
  if (node.items !== undefined || Array.isArray(node.prefixItems)) return 'array'
  if (typeof node.pattern === 'string' || typeof node.format === 'string') return 'string'
  if (node.minimum !== undefined || node.maximum !== undefined) return 'number'
  return 'object'
}

function inferTypeFromValues(values: readonly unknown[]): string | null {
  const kinds = new Set<string>()
  for (const value of values) {
    if (value === null) continue
    if (typeof value === 'string') kinds.add('string')
    else if (typeof value === 'boolean') kinds.add('boolean')
    else if (typeof value === 'number') kinds.add(Number.isInteger(value) ? 'integer' : 'number')
    else if (Array.isArray(value)) kinds.add('array')
    else if (typeof value === 'object') kinds.add('object')
  }
  if (kinds.size === 0) return null
  if (kinds.size === 1) return [...kinds][0] ?? null
  if (kinds.size === 2 && kinds.has('integer') && kinds.has('number')) return 'number'
  return null
}

function renderEnumValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** JSON-shaped deep clone. Tolerates the odd non-JSON value by passing it through. */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson)
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = cloneJson(v)
    return out
  }
  return value
}
