/**
 * Types the setup wizard sends across the IPC boundary.
 *
 * Separate from the modules that produce them because both sides need them and
 * the renderer must not import anything that touches the filesystem.
 */

export interface ProbeModel {
  id: string
  /** Already in memory on the server — the sensible default to offer. */
  loaded: boolean
  contextLength?: number
}

export interface ProbeResult {
  host: string
  /** The OpenAI-compatible API answered and listed models. */
  api: boolean
  /** LM Studio's native endpoint answered too, so live telemetry will work. */
  native: boolean
  models: ProbeModel[]
  baseUrl: string
  nativeApiUrl: string
  /** Set only when `api` is false, and written to be acted on. */
  error?: string
  latencyMs?: number
}

export interface ProvisionProgress {
  id: string
  phase: 'copying' | 'creating-env' | 'installing' | 'done' | 'failed'
  error?: string
}

export interface ProvisionResult {
  installed: string[]
  failed: { id: string; error: string }[]
  root: string
}

export type FieldKind = 'secret' | 'url' | 'email'

export interface CredentialField {
  key: string
  label: string
  kind: FieldKind
  file?: string
  /** What still works if this is left empty. Empty string means nothing does. */
  withoutIt: string
  /** Filled from the inference server the wizard verified, not typed. */
  derivedFromServer?: boolean
  placeholder?: string
}

export interface ServerCredentials {
  serverId: string
  label: string
  fields: CredentialField[]
}

export interface CredentialState {
  serverId: string
  key: string
  set: boolean
  /** Length only, for secrets — never the value. */
  length: number
  /** Present for non-secrets, where hiding it would make the panel useless. */
  value?: string
}

/** One installable server, as the wizard's checklist sees it. */
export interface SetupServer {
  id: string
  label: string
  blurb: string
  tier: 'core' | 'optional'
  /** Roughly what this adds to install time and disk. */
  cost?: string
  /** Extra requirement the wizard should state plainly, e.g. a ComfyUI host. */
  requires?: string
  installed: boolean
}

export type ModelSlot = 'unet' | 'clip' | 'vae' | 'checkpoint'

export interface RequiredModel {
  feature: string
  slot: ModelSlot
  file: string
  /** Where it has to be put, e.g. "text_encoders/qwen_3_4b.safetensors". */
  where: string
}

export interface ModelReport {
  reachable: boolean
  error?: string
  present: RequiredModel[]
  missing: RequiredModel[]
  /** Loaders the server does not expose — cannot tell, rather than missing. */
  unknownSlots: ModelSlot[]
}

export interface SetupState {
  /** True until setup is completed once. */
  firstRun: boolean
  servers: SetupServer[]
  credentials: ServerCredentials[]
  states: CredentialState[]
}
