/**
 * Native tool catalog.
 *
 * These schemas are sent to the model on every single request, so every word
 * here is paid for repeatedly. Descriptions state the contract and the traps
 * (what is refused, what the defaults are) and nothing else — a model that has
 * to guess costs far more tokens in retries than a precise sentence costs here.
 */

import type { JsonSchema, NativeToolId, NativeToolInfo, WireTool } from '@shared/types'
import { toolSchemaTokens } from '../mcp/tokens'

const PATH_HINT = 'Absolute path, or relative to the workspace root. ~ is expanded.'

interface ToolSpec {
  id: NativeToolId
  description: string
  mutating: boolean
  schema: JsonSchema
}

const SPECS: ToolSpec[] = [
  {
    id: 'read_file',
    mutating: false,
    description:
      'Read a text file. Returns lines numbered cat -n style; the numbers are not part of the file. Reads at most 2000 lines from the start unless offset/limit say otherwise. Files over 2MB and binary files are refused.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HINT },
        offset: { type: 'number', description: 'First line to read, 1-based. Default 1.' },
        limit: { type: 'number', description: 'Maximum lines to return. Default 2000.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    id: 'write_file',
    mutating: true,
    description:
      'Write a file, replacing it entirely and creating parent directories as needed. Read an existing file before overwriting it; use edit_file for targeted changes.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HINT },
        content: { type: 'string', description: 'Full file content.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    id: 'edit_file',
    mutating: true,
    description:
      'Replace an exact substring in a file. old_string must match the file byte for byte, including indentation, and must be unique unless replace_all is true — include surrounding lines to make it unique. Fails without editing if it is missing or ambiguous.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HINT },
        old_string: { type: 'string', description: 'Exact text to find.' },
        new_string: { type: 'string', description: 'Text to put in its place. Empty string deletes it.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring exactly one. Default false.'
        }
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false
    }
  },
  {
    id: 'list_dir',
    mutating: false,
    description: 'List one directory level. Directories come first and end in a slash.',
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: PATH_HINT }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    id: 'glob',
    mutating: false,
    description:
      'Find files by glob pattern, e.g. "src/**/*.ts". Returns absolute paths, sorted. node_modules, .git and build output are never searched.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. ** matches across directories.' },
        path: { type: 'string', description: 'Directory to search in. Defaults to the workspace root.' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    id: 'grep',
    mutating: false,
    description:
      'Search file contents by regular expression. Returns file:line:text. Use this to find code rather than reading files one by one.',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' }
      },
      required: ['pattern'],
      additionalProperties: false
    }
  },
  {
    id: 'run_shell',
    mutating: true,
    description:
      'Run a command with /bin/zsh -lc and return its exit code, stdout and stderr. stdin is closed, so anything interactive fails instead of answering. Keep commands single-purpose.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory. Defaults to the workspace root.' },
        timeout_ms: { type: 'number', description: 'Timeout in ms. Default 120000, maximum 600000.' }
      },
      required: ['command'],
      additionalProperties: false
    }
  }
]

export const NATIVE_TOOLS: NativeToolInfo[] = SPECS.map((spec) => ({
  id: spec.id,
  name: spec.id,
  description: spec.description,
  inputSchema: spec.schema,
  mutating: spec.mutating,
  tokens: toolSchemaTokens(spec.id, spec.description, spec.schema)
}))

const BY_ID = new Map<NativeToolId, NativeToolInfo>(NATIVE_TOOLS.map((t) => [t.id, t]))

/** Wire tools for the enabled subset, in catalog order so the payload is stable. */
export function nativeWireTools(enabled: NativeToolId[]): WireTool[] {
  const wanted = new Set(enabled)
  const out: WireTool[] = []
  for (const tool of NATIVE_TOOLS) {
    if (!wanted.has(tool.id)) continue
    out.push({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    })
  }
  return out
}

export function nativeToolInfo(id: NativeToolId): NativeToolInfo | undefined {
  return BY_ID.get(id)
}

export function isNativeToolId(name: string): name is NativeToolId {
  return BY_ID.has(name as NativeToolId)
}
