/**
 * Per-server credentials and the addresses that are wrong on a new machine.
 *
 * There are only three actual secrets across thirteen servers, which is worth
 * knowing before building anything elaborate: a Duffel token, an optional Brave
 * key, and Gmail's OAuth (which the npm package handles itself in a browser and
 * this module deliberately does not touch).
 *
 * The larger category is addresses. Three servers each carry their OWN
 * inference URL for their vision calls — PWMCP_LMSTUDIO_URL,
 * UIREVIEW_LMSTUDIO_URL, COMFY_LMSTUDIO_URL — and all three default to
 * 127.0.0.1. On the machine that runs the models that is right by accident; on
 * any other machine browser vision quietly answers from the wrong box, with no
 * error to notice. Setup writes them, which is why they are listed here beside
 * the secrets rather than left to a config file nobody opens.
 *
 * Nothing here is written into settings.json. That file is the one most likely
 * to be pasted into a chat window or copied between machines; a token belongs
 * in the server's own directory, or in an env entry read at launch.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { CredentialField, CredentialState, ServerCredentials } from '@shared/setup'

/**
 * Everything a server needs that this machine cannot work out for itself.
 *
 * Kept as data rather than as wizard markup so the same list drives the setup
 * step and the settings panel — a credential you can enter once during install
 * and never fix afterwards is a trap.
 */
export const CREDENTIAL_SPEC: ServerCredentials[] = [
  {
    serverId: 'flights',
    label: 'Flights',
    fields: [
      {
        key: 'duffel_token',
        label: 'Duffel API token',
        kind: 'secret',
        file: 'credentials.json',
        withoutIt: 'Flight search will not work at all.',
        placeholder: 'duffel_test_…'
      }
    ]
  },
  {
    serverId: 'websearch',
    label: 'Web search',
    fields: [
      {
        key: 'BRAVE_API_KEY',
        label: 'Brave Search API key',
        kind: 'secret',
        withoutIt: 'Web search still works, using DuckDuckGo instead.',
        placeholder: 'optional'
      }
    ]
  },
  {
    serverId: 'playwright',
    label: 'Browser',
    fields: [
      {
        key: 'PWMCP_LMSTUDIO_URL',
        label: 'Inference server for page vision',
        kind: 'url',
        derivedFromServer: true,
        withoutIt: 'The browser works, but asking it what a page LOOKS like will fail.'
      }
    ]
  },
  {
    serverId: 'ui-review',
    label: 'UI review',
    fields: [
      {
        key: 'UIREVIEW_LMSTUDIO_URL',
        label: 'Inference server for design critique',
        kind: 'url',
        derivedFromServer: true,
        withoutIt: 'Screenshots still render; the critique of them will fail.'
      }
    ]
  },
  {
    serverId: 'comfy-image',
    label: 'Image generation',
    fields: [
      {
        key: 'COMFY_HOST',
        label: 'ComfyUI address',
        kind: 'url',
        withoutIt: 'Image generation and editing will not work.',
        placeholder: 'http://127.0.0.1:8188'
      },
      {
        key: 'COMFY_LMSTUDIO_URL',
        label: 'Inference server for image critique',
        kind: 'url',
        derivedFromServer: true,
        withoutIt: 'Images still generate; the critique loop will fail.'
      }
    ]
  },
  {
    serverId: 'comfy-audio',
    label: 'Audio generation',
    fields: [
      {
        key: 'COMFY_HOST',
        label: 'ComfyUI address',
        kind: 'url',
        withoutIt: 'Music and sound effects will not work.',
        placeholder: 'http://127.0.0.1:8188'
      }
    ]
  },
  {
    serverId: 'health',
    label: 'Health',
    fields: [
      {
        key: 'HEALTH_CONTACT_EMAIL',
        label: 'Contact email',
        kind: 'email',
        withoutIt: 'The upstream API requires a contact address and will refuse requests.',
        placeholder: 'you@example.com'
      }
    ]
  }
]

const ENV_FILE = 'env.json'

function envPath(installRoot: string, serverId: string): string {
  return join(installRoot, serverId, ENV_FILE)
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function writeJson(file: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true })
  /* 0600: a token in a world-readable file is a token in a backup, a Time
     Machine snapshot and anything else that walks the home directory. */
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
}

export function fieldFor(serverId: string, key: string): CredentialField | undefined {
  return CREDENTIAL_SPEC.find((s) => s.serverId === serverId)?.fields.find((f) => f.key === key)
}

export function setCredential(
  installRoot: string,
  serverId: string,
  key: string,
  value: string
): void {
  const field = fieldFor(serverId, key)
  if (!field) throw new Error(`unknown credential ${serverId}.${key}`)

  if (field.file) {
    const file = join(installRoot, serverId, field.file)
    const data = readJson(file)
    if (value === '') delete data[key]
    else data[key] = value
    writeJson(file, data)
    return
  }

  const file = envPath(installRoot, serverId)
  const data = readJson(file)
  if (value === '') delete data[key]
  else data[key] = value
  writeJson(file, data)
}

/** Every credential's state, with secret VALUES withheld by construction. */
export function credentialStates(installRoot: string): CredentialState[] {
  const out: CredentialState[] = []
  for (const server of CREDENTIAL_SPEC) {
    for (const field of server.fields) {
      const file = field.file
        ? join(installRoot, server.serverId, field.file)
        : envPath(installRoot, server.serverId)
      const raw = readJson(file)[field.key]
      const value = typeof raw === 'string' ? raw : ''
      out.push({
        serverId: server.serverId,
        key: field.key,
        set: value !== '',
        length: value.length,
        /* A URL or an email is not a secret, and hiding it makes the panel
           useless — you cannot tell a wrong host from a right one behind
           dots. Only 'secret' fields are withheld. */
        ...(field.kind === 'secret' ? {} : { value })
      })
    }
  }
  return out
}

/** Env entries for launching a server, merged over whatever the caller has. */
export function envFor(installRoot: string, serverId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(readJson(envPath(installRoot, serverId)))) {
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
}

/**
 * Point every server that holds its own inference URL at the one just verified.
 *
 * Called with whatever the wizard probed, so the three vision-capable servers
 * agree with the app instead of each defaulting to localhost.
 */
export function applyServerUrl(installRoot: string, baseUrl: string, installed?: string[]): string[] {
  const touched: string[] = []
  for (const server of CREDENTIAL_SPEC) {
    /* Only servers that are actually here.
     *
     * Writing an env file for a server nobody installed CREATES its directory,
     * and a directory is what "is this installed?" was being answered with —
     * so a wizard run that skipped image generation still listed it as
     * installed, pointing at a folder containing one env file and no server. */
    if (installed && !installed.includes(server.serverId)) continue
    for (const field of server.fields) {
      if (!field.derivedFromServer) continue
      setCredential(installRoot, server.serverId, field.key, baseUrl)
      touched.push(`${server.serverId}.${field.key}`)
    }
  }
  return touched
}
