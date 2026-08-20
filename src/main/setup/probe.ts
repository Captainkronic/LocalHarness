/**
 * Find out whether there is actually an inference server where someone says.
 *
 * The wizard's first question is the only one it cannot guess, and getting a
 * wrong answer past it produces an install that looks finished and does
 * nothing. So the host is not merely recorded — it is asked, on both ports the
 * app uses, and the answer decides whether setup can continue.
 *
 * Two ports, because they are different services and only one of them is
 * required. :1235 is the OpenAI-compatible API every turn goes through. :1234
 * is LM Studio's native endpoint, which the Lab feed and the live meter read
 * for real prefill and decode numbers. A host answering only the first is
 * perfectly usable; it just loses the telemetry, and the wizard should say so
 * rather than fail.
 */

import type { ProbeModel, ProbeResult } from '@shared/setup'

/** Accepts "studio.local", "http://x:1235", "x:1235/v1" and so on. */
export function normaliseHost(input: string): { host: string; apiPort: number; nativePort: number } {
  let raw = input.trim()
  raw = raw.replace(/^https?:\/\//i, '').replace(/\/+.*$/, '')
  const [hostPart, portPart] = raw.split(':')
  const host = (hostPart ?? '').trim() || '127.0.0.1'
  const port = portPart ? Number.parseInt(portPart, 10) : NaN
  /* A host given with an explicit port means that port for the API; the native
     endpoint is conventionally one below in this setup, but only guessed when
     the user did not say. */
  return {
    host,
    apiPort: Number.isFinite(port) ? port : 1235,
    nativePort: Number.isFinite(port) && port !== 1235 ? port - 1 : 1234
  }
}

async function getJson(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()) as unknown
}

function modelsFrom(payload: unknown): ProbeModel[] {
  if (payload === null || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data
    .map((entry): ProbeModel | null => {
      if (entry === null || typeof entry !== 'object') return null
      const rec = entry as Record<string, unknown>
      const id = typeof rec['id'] === 'string' ? rec['id'] : null
      if (id === null) return null
      const ctx = rec['loaded_context_length'] ?? rec['max_context_length']
      return {
        id,
        loaded: rec['state'] === 'loaded',
        ...(typeof ctx === 'number' ? { contextLength: ctx } : {})
      }
    })
    .filter((m): m is ProbeModel => m !== null)
}

export async function probeServer(
  input: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000
): Promise<ProbeResult> {
  const { host, apiPort, nativePort } = normaliseHost(input)
  const baseUrl = `http://${host}:${apiPort}/v1`
  const nativeApiUrl = `http://${host}:${nativePort}`
  const base: ProbeResult = { host, api: false, native: false, models: [], baseUrl, nativeApiUrl }

  const started = Date.now()
  let models: ProbeModel[] = []
  try {
    /* LM Studio's richer list first — it reports which models are actually
       loaded, and a loaded model is the only sensible default to offer. */
    models = modelsFrom(await getJson(`http://${host}:${apiPort}/api/v0/models`, timeoutMs, fetchImpl))
  } catch {
    /* Fine: any OpenAI-compatible server has /v1/models, it just says less. */
  }
  if (models.length === 0) {
    try {
      models = modelsFrom(await getJson(`${baseUrl}/models`, timeoutMs, fetchImpl))
    } catch (err) {
      return { ...base, error: describe(err, host, apiPort) }
    }
  }

  const latencyMs = Date.now() - started
  let native = false
  try {
    await getJson(`${nativeApiUrl}/api/v0/models`, timeoutMs, fetchImpl)
    native = true
  } catch {
    /* Not fatal — see the header. */
  }

  return { ...base, api: true, native, models, latencyMs }
}

/**
 * Say what actually went wrong.
 *
 * "Failed to fetch" sends someone to check their model list. The distinction
 * between nothing listening, a name that will not resolve, and a link too slow
 * to answer sends them to three different places.
 */
function describe(err: unknown, host: string, port: number): string {
  /*
   * Unwrap before matching.
   *
   * Node's fetch reports almost everything as `TypeError: fetch failed` and
   * puts the real fault — ENOTFOUND, ECONNREFUSED — on `.cause`. Matching the
   * top-level message means every failure reads the same and the advice is
   * always wrong. This app has already been caught by exactly this once, with
   * a `terminated` TypeError whose cause was a body timeout; the lesson is to
   * test the error rather than a rendering of it.
   */
  const chain: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 5 && cur !== null && cur !== undefined; depth++) {
    if (cur instanceof Error) {
      chain.push(cur.name, cur.message)
      const code = (cur as NodeJS.ErrnoException).code
      if (typeof code === 'string') chain.push(code)
      cur = cur.cause
    } else {
      chain.push(String(cur))
      break
    }
  }
  const raw = chain.join(' ')

  if (/TimeoutError|timed out|aborted/i.test(raw)) {
    return `${host} did not answer within the timeout. If it is on Tailscale, check the machine is awake.`
  }
  if (/ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(raw)) {
    return `The name "${host}" does not resolve from this machine.`
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return `${host} is reachable but nothing is listening on port ${port}. Is LM Studio's server started?`
  }
  if (/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/i.test(raw)) {
    return `${host} cannot be reached from this network.`
  }
  const message = err instanceof Error ? err.message : String(err)
  return `${host}:${port} — ${message}`
}
