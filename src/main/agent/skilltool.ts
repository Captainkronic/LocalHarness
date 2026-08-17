/**
 * The `use_skill` tool.
 *
 * ONE tool, whose description carries the catalogue of enabled skills — name and
 * description only. That is the entire per-message cost of the skill system: a
 * few dozen tokens for the whole library, no matter how long the skills
 * themselves are. The model reads a skill's instructions only when it decides
 * they apply, by calling this tool and paying for the body once, in the middle
 * of a turn, instead of on every message forever.
 *
 * Compare an MCP server, whose full tool schemas are re-sent on every single
 * message (comfy-image alone is 3,007 tokens). Keeping the body out of the
 * prompt is not an optimisation here, it is the feature.
 *
 * When nothing is enabled the tool does not exist at all — an empty array, not a
 * tool that answers "no skills available". A tool the model can never use
 * successfully still costs tokens and still invites a wasted call.
 */

import type { Skill, WireTool } from '@shared/types'

import { skillCatalogue, splitFrontmatter, type SkillRegistry } from '../skills/registry'

export const SKILL_TOOL_NAME = 'use_skill'

/**
 * Cap on the body handed back to the model. Adam's skills are 4-8KB; anything
 * approaching this is a document that has wandered into a skill folder, and
 * silently blowing the context window on it would be worse than saying so.
 */
const MAX_BODY_CHARS = 120_000

/** Argument keys a local model plausibly uses instead of the documented one. */
const NAME_KEYS = ['name', 'skill', 'skill_name', 'skillName', 'id', 'title'] as const

/**
 * The tool, or nothing.
 *
 * The `name` argument is a plain string rather than an `enum` of skill names on
 * purpose: `sanitizeSchema` strips enums (several Gemma chat templates throw on
 * them — see ../mcp/tokens.ts), so the enum would be deleted before the model
 * ever saw it. The catalogue in the description is what tells the model which
 * names are legal, and `runSkillTool` matches leniently to cover the rest.
 */
export function skillTools(skills: Skill[]): WireTool[] {
  const enabled = skills.filter((s) => s.enabled)
  if (enabled.length === 0) return []

  return [
    {
      type: 'function',
      function: {
        name: SKILL_TOOL_NAME,
        description: buildDescription(enabled),
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact skill name, copied from the list in this tool description.'
            }
          },
          required: ['name'],
          additionalProperties: false
        }
      }
    }
  ]
}

function buildDescription(enabled: Skill[]): string {
  return [
    "Read the full instructions for one of the skills installed on this machine. A skill is the user's own playbook for a kind of work; when one covers the task, call this BEFORE starting and then follow what it says.",
    'The list below is all you have — the instructions themselves arrive only when you ask for them, so call this rather than guessing at what a skill contains.',
    '',
    'Available skills:',
    skillCatalogue(enabled)
  ].join('\n')
}

/**
 * Runs the tool. Returns the SKILL.md body as text; the frontmatter is stripped
 * because its name and description are already in the prompt and re-sending them
 * would be paying twice.
 */
export async function runSkillTool(
  name: string,
  args: unknown,
  registry: SkillRegistry
): Promise<{ text: string; isError: boolean }> {
  if (name !== SKILL_TOOL_NAME) {
    return { text: `runSkillTool was called for "${name}", which is not ${SKILL_TOOL_NAME}.`, isError: true }
  }

  const available = registry.list().filter((s) => s.enabled)
  if (available.length === 0) {
    return { text: 'No skills are enabled, so there is nothing to read.', isError: true }
  }

  const requested = readRequestedName(args)
  if (requested === null) {
    return {
      text: `${SKILL_TOOL_NAME} needs a "name". ${availableLine(available)}`,
      isError: true
    }
  }

  const skill = findSkill(available, requested)
  if (skill === undefined) {
    return {
      text: `There is no skill called "${requested}". ${availableLine(available)}`,
      isError: true
    }
  }

  const raw = await registry.read(skill.path)
  if (raw === null) {
    return { text: `Could not read ${skill.path}. The skill may have been moved or deleted.`, isError: true }
  }

  const body = splitFrontmatter(raw).body.trim()
  if (body.length === 0) {
    return {
      text: `"${skill.name}" has frontmatter but no instructions in ${skill.path}.`,
      isError: true
    }
  }

  const truncated =
    body.length > MAX_BODY_CHARS
      ? `${body.slice(0, MAX_BODY_CHARS)}\n\n[truncated at ${MAX_BODY_CHARS} characters of ${body.length}]`
      : body

  // The folder matters: skills reference companion files relative to their own
  // directory ("references/palette.md"), and without it the model cannot resolve
  // one with read_file.
  const header = [
    `Skill: ${skill.name} — follow these instructions for the current task.`,
    `Folder: ${skill.dir} (any file the skill refers to is relative to this folder)`
  ].join('\n')

  return { text: `${header}\n\n${truncated}`, isError: false }
}

/* ------------------------------------------------------------------ */
/* Argument handling                                                   */
/* ------------------------------------------------------------------ */

/** Accepts `{name}`, the handful of keys models substitute for it, or a bare
 *  string — a local model that got the wrapper wrong still knows what it wants. */
function readRequestedName(args: unknown): string | null {
  if (typeof args === 'string') return nonEmpty(args)
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return null

  const record = args as Record<string, unknown>
  for (const key of NAME_KEYS) {
    const value = record[key]
    if (typeof value === 'string') {
      const trimmed = nonEmpty(value)
      if (trimmed !== null) return trimmed
    }
  }
  return null
}

function nonEmpty(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Lenient matching, in order: exact, then the part before a colon (models like
 * to paste the whole catalogue line back), then punctuation-insensitive ("web
 * game dev" for `web-game-dev`), then a single unambiguous substring. Anything
 * ambiguous fails rather than guessing at which skill was meant.
 */
function findSkill(skills: Skill[], requested: string): Skill | undefined {
  const candidates = [requested, requested.split(':')[0] ?? requested]
    .map((c) => c.trim())
    .filter((c) => c.length > 0)

  for (const candidate of candidates) {
    const exact = skills.find((s) => s.name.toLowerCase() === candidate.toLowerCase())
    if (exact !== undefined) return exact
  }

  for (const candidate of candidates) {
    const key = normalize(candidate)
    if (key.length === 0) continue
    const loose = skills.filter((s) => normalize(s.name) === key)
    if (loose.length === 1) return loose[0]
  }

  for (const candidate of candidates) {
    const key = normalize(candidate)
    if (key.length < 3) continue
    const partial = skills.filter((s) => normalize(s.name).includes(key))
    if (partial.length === 1) return partial[0]
  }

  return undefined
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Names only in the failure path — the descriptions are already in the prompt,
 *  so repeating them in a tool result would be paying for them twice. */
function availableLine(skills: Skill[]): string {
  return `Available skills: ${skills.map((s) => s.name).join(', ')}.`
}
