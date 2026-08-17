import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type {
  CatalogModel,
  LoadOptions,
  LoadProgress,
  LoadedInstance
} from '@shared/types'
import { clamp01, formatBytes } from '@renderer/lib/format'
import './models.css'

/**
 * The load form.
 *
 * Two things it refuses to be vague about:
 *
 *  1. Every control starts at "server default" and only what the user actually
 *     touched is sent. An unsent field is not the same as a field set to the
 *     value that happens to be the default, and the load stack treats them
 *     differently.
 *  2. This box holds one large model at a time. A load requested while a 27B is
 *     resident fails with "insufficient system resources" after a long wait, so
 *     the warning and the unload-first path are in front of the button rather
 *     than in the error afterwards.
 */

export interface LoadDialogProps {
  model: CatalogModel
  /** The variant chosen in the row — this, not `model.modelKey`, is what loads. */
  modelKey: string
  /** Everything currently resident, for the eviction warning. */
  resident: LoadedInstance[]
  /** Live progress for the load in flight, or null. */
  progress: LoadProgress | null
  /** Last control-channel error, shown verbatim. */
  error?: string
  onLoad: (modelKey: string, options: LoadOptions) => void
  onUnloadThenLoad: (identifier: string, modelKey: string, options: LoadOptions) => void
  onCancelLoad: () => void
  onClose: () => void
}

/**
 * The largest window this machine has been measured running cleanly at for a
 * 27B, by engine. Observed reference points from real runs — the server enforces
 * neither, and a bigger number is allowed, it just costs memory.
 */
const MEASURED_SAFE = { gguf: 163_840, mlx: 49_152 } as const

/** MLX's own auto-fit choice on this box, which already overruns into swap. */
const MLX_AUTOFIT_OBSERVED = 73_728

const CACHE_QUANTS = ['f16', 'q8_0', 'q4_0'] as const

const CTX_STEP = 1024
const CTX_MIN = 1024

function isMlx(format: string): boolean {
  return format.toLowerCase().includes('mlx')
}

function fullCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function phaseWord(phase: LoadProgress['phase']): string {
  switch (phase) {
    case 'resolving':
      return 'Resolving model…'
    case 'loading':
      return 'Loading into memory…'
    case 'done':
      return 'Loaded'
    default:
      return 'Load failed'
  }
}

/**
 * Three-position control for an optional boolean: not sent / true / false.
 * A plain switch cannot express "leave it to the server", and that is the
 * default for every one of these fields.
 */
function TriState(props: {
  label: string
  value: boolean | null
  disabled?: boolean
  onChange: (v: boolean | null) => void
}): JSX.Element {
  const { label, value, disabled, onChange } = props
  const options: Array<{ v: boolean | null; text: string }> = [
    { v: null, text: 'Server default' },
    { v: true, text: 'On' },
    { v: false, text: 'Off' }
  ]
  return (
    <div className="mm-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.v)}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          className={value === o.v ? 'mm-seg-btn is-on' : 'mm-seg-btn'}
          disabled={disabled === true}
          onClick={() => onChange(o.v)}
        >
          {o.text}
        </button>
      ))}
    </div>
  )
}

function XIcon(): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function LoadDialog(props: LoadDialogProps): JSX.Element {
  const {
    model,
    modelKey,
    resident,
    progress,
    error,
    onLoad,
    onUnloadThenLoad,
    onCancelLoad,
    onClose
  } = props

  const mlx = isMlx(model.format)
  const engine = mlx ? 'MLX' : 'llama.cpp'
  const maxCtx = model.maxContextLength > 0 ? model.maxContextLength : null
  const safeCeiling = mlx ? MEASURED_SAFE.mlx : MEASURED_SAFE.gguf

  const [contextLength, setContextLength] = useState<number | null>(null)
  /** The number field's own text. Kept separate so a half-typed number is not
   *  clamped out from under the cursor — "1" on the way to "163840" would
   *  otherwise snap to the minimum. */
  const [contextText, setContextText] = useState('')
  const [autoFit, setAutoFit] = useState<boolean | null>(null)
  const [flashAttention, setFlashAttention] = useState<boolean | null>(null)
  const [kCache, setKCache] = useState('')
  const [vCache, setVCache] = useState('')
  const [threads, setThreads] = useState<number | null>(null)
  const [offload, setOffload] = useState<number | null>(null)
  const [ttlMinutes, setTtlMinutes] = useState<number | null>(null)
  /** Sticks after the progress channel reports a failure, which is transient. */
  const [failure, setFailure] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    if (progress?.phase === 'error') {
      setFailure(progress.message ?? 'The server rejected the load and gave no message.')
    }
  }, [progress?.phase, progress?.message])

  const loading = progress !== null && progress.phase !== 'error'

  // A quantized V cache is not merely slower without flash attention; it fails
  // to load. Leaving flash at the server default is not good enough — we cannot
  // see what that default is.
  const vQuantized = vCache !== '' && vCache !== 'f16'
  const blocked = vQuantized && flashAttention !== true

  const options = useMemo((): LoadOptions => {
    const o: LoadOptions = {}
    if (contextLength !== null) o.contextLength = contextLength
    if (autoFit !== null) o.autoFit = autoFit
    if (!mlx) {
      if (flashAttention !== null) o.flashAttention = flashAttention
      if (kCache !== '') o.kCacheQuantization = kCache
      if (vCache !== '') o.vCacheQuantization = vCache
      if (threads !== null) o.cpuThreadPoolSize = threads
      if (offload !== null) o.gpuOffloadRatio = offload
    }
    if (ttlMinutes !== null) o.ttlMs = Math.round(ttlMinutes * 60_000)
    return o
  }, [contextLength, autoFit, flashAttention, kCache, vCache, threads, offload, ttlMinutes, mlx])

  const setCount = Object.keys(options).length

  const submit = (): void => {
    setFailure(null)
    onLoad(modelKey, options)
  }

  const evictThenSubmit = (identifier: string): void => {
    setFailure(null)
    onUnloadThenLoad(identifier, modelKey, options)
  }

  const setContext = (n: number | null): void => {
    setContextLength(n)
    setContextText(n === null ? '' : String(n))
  }

  /** While typing, only the architectural ceiling is enforced — the floor waits
   *  for blur so the field stays typeable. */
  const typeContext = (raw: string): void => {
    setContextText(raw)
    if (raw.trim() === '') {
      setContextLength(null)
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) return
    setContextLength(maxCtx === null ? Math.round(n) : Math.min(Math.round(n), maxCtx))
  }

  const normalizeContext = (): void => {
    if (contextLength === null) {
      setContextText('')
      return
    }
    setContext(Math.max(CTX_MIN, contextLength))
  }

  const overSafe = contextLength !== null && contextLength > safeCeiling
  const tickPct = maxCtx === null ? null : clamp01(safeCeiling / maxCtx) * 100

  return createPortal(
    <div className="mm-dlg-scrim" role="presentation" onMouseDown={onClose}>
      <div
        className="mm-dlg"
        role="dialog"
        aria-modal="true"
        aria-label={`Load ${model.displayName}`}
        tabIndex={-1}
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="mm-dlg-head">
          <div className="mm-dlg-headtext">
            <div className="mm-dlg-title">
              <span className="mm-dlg-name">Load {model.displayName}</span>
              <span className={`mm-badge ${mlx ? 'is-mlx' : 'is-gguf'}`}>{model.format}</span>
            </div>
            <span className="mm-card-key" title={modelKey}>
              {modelKey}
            </span>
            <div className="mm-facts">
              <span className="mm-fact">
                <span className="mm-fact-k">weights</span>
                <span className="mm-fact-v tnum">{formatBytes(model.sizeBytes)}</span>
              </span>
              <span className="mm-fact">
                <span className="mm-fact-k">params</span>
                <span className="mm-fact-v tnum">{model.paramsString || '—'}</span>
              </span>
              <span className="mm-fact">
                <span className="mm-fact-k">max ctx</span>
                <span className="mm-fact-v tnum">
                  {maxCtx === null ? '—' : fullCount(maxCtx)}
                </span>
              </span>
              <span className="mm-fact">
                <span className="mm-fact-k">engine</span>
                <span className="mm-fact-v">{engine}</span>
              </span>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label="Close load dialog"
            onClick={onClose}
          >
            <XIcon />
          </button>
        </header>

        <div className="mm-dlg-body scroll-y">
          {resident.length > 0 ? (
            <div className="mm-alert is-warn">
              <span className="mm-alert-title">
                {resident.length === 1
                  ? `${resident[0].displayName} is already resident`
                  : `${resident.length} models are already resident`}
              </span>
              <p className="mm-alert-body">
                This machine fits one large model at a time — its 30 GiB working set holds the
                weights and the KV cache together. Loading now will most likely fail with{' '}
                <code>insufficient system resources</code> after a long wait, unless the
                resident model is unloaded first.
              </p>
              <div className="mm-alert-actions">
                {resident.map((r) => (
                  <button
                    key={r.identifier}
                    type="button"
                    className="btn btn-sm"
                    disabled={loading}
                    onClick={() => evictThenSubmit(r.identifier)}
                  >
                    Unload {r.displayName} first
                    <span className="tnum">({formatBytes(r.sizeBytes)})</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {/* ---- context length ---- */}
          <div className="mm-field">
            <div className="mm-field-head">
              <span className="mm-field-label">Context length</span>
              <span className={contextLength === null ? 'mm-field-value is-unset' : 'mm-field-value tnum'}>
                {contextLength === null ? 'server decides' : fullCount(contextLength)}
              </span>
              {contextLength !== null ? (
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setContext(null)}
                >
                  Unset
                </button>
              ) : null}
            </div>

            <div className="mm-field-row">
              <input
                className="mm-input is-narrow tnum"
                type="number"
                min={CTX_MIN}
                max={maxCtx ?? undefined}
                step={CTX_STEP}
                placeholder="server decides"
                value={contextText}
                disabled={loading}
                onChange={(e) => typeContext(e.target.value)}
                onBlur={normalizeContext}
              />
              <input
                className="mm-range"
                type="range"
                min={CTX_MIN}
                max={maxCtx ?? CTX_MIN * 8}
                step={CTX_STEP}
                aria-label="Context length"
                disabled={loading || maxCtx === null}
                value={contextLength ?? Math.min(safeCeiling, maxCtx ?? safeCeiling)}
                onChange={(e) => setContext(Number(e.target.value))}
              />
            </div>

            {tickPct !== null ? (
              <div className="mm-scale" aria-hidden="true">
                <span className="mm-scale-tick" style={{ left: `${tickPct}%` }} />
              </div>
            ) : null}

            <div className="mm-scale-legend">
              <span>
                <i aria-hidden="true" />
                measured safe on this box: {engine} ≈{' '}
                <span className="tnum">{fullCount(safeCeiling)}</span>
              </span>
              <span>
                other engine: {mlx ? 'GGUF' : 'MLX 4-bit'} ≈{' '}
                <span className="tnum">
                  {fullCount(mlx ? MEASURED_SAFE.gguf : MEASURED_SAFE.mlx)}
                </span>
              </span>
            </div>

            <p className="mm-hint">
              The window is KV cache, held in the same working set as the weights — every extra
              token costs memory that the model itself is using. Those two figures are observed
              reference points from real runs here, not limits the server enforces.
            </p>
            {overSafe ? (
              <p className="mm-hint is-warn">
                Above the largest window measured running cleanly here for a 27B. It may still
                load, and it may spill into swap, which shows up as throughput collapsing rather
                than as an error.
              </p>
            ) : null}
          </div>

          {/* ---- auto-fit ---- */}
          <div className="mm-field">
            <div className="mm-field-head">
              <span className="mm-field-label">Auto-fit context</span>
              <TriState
                label="Auto-fit context"
                value={autoFit}
                disabled={loading}
                onChange={setAutoFit}
              />
            </div>
            <p className="mm-hint">
              Lets the engine size the window itself.{' '}
              {mlx
                ? `On MLX this has historically overridden the requested context length entirely — a number set above that comes back ignored, which is the engine’s behaviour and not this app dropping it. MLX auto-fit picked ${fullCount(
                    MLX_AUTOFIT_OBSERVED
                  )} here, which already overruns into swap.`
                : 'On llama.cpp this sizes the window to whatever the engine thinks fits, which may be smaller than the number set above.'}
            </p>
          </div>

          {/* ---- flash attention ---- */}
          <div className="mm-field">
            <div className="mm-field-head">
              <span className="mm-field-label">Flash attention</span>
              <TriState
                label="Flash attention"
                value={flashAttention}
                disabled={loading || mlx}
                onChange={setFlashAttention}
              />
            </div>
            <p className="mm-hint">
              {mlx
                ? 'llama.cpp only. This is an MLX model, which has no flash-attention switch — the setting would be ignored, so it is not sent.'
                : 'Cheaper attention over long windows, and a hard requirement for a quantized V cache.'}
            </p>
          </div>

          {/* ---- KV cache quantization ---- */}
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-field-label">K cache quantization</span>
              <select
                className="mm-input mm-select"
                value={kCache}
                disabled={loading || mlx}
                onChange={(e) => setKCache(e.target.value)}
              >
                <option value="">server default</option>
                {CACHE_QUANTS.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>

            <label className="mm-field">
              <span className="mm-field-label">V cache quantization</span>
              <select
                className="mm-input mm-select"
                value={vCache}
                disabled={loading || mlx}
                onChange={(e) => setVCache(e.target.value)}
              >
                <option value="">server default</option>
                {CACHE_QUANTS.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mm-hint">
            {mlx
              ? 'llama.cpp only — MLX manages its own cache, so neither field is sent for this model.'
              : 'Quantizing the cache roughly doubles the window a given amount of memory holds, at a few percent of speed.'}
          </p>
          {blocked ? (
            <p className="mm-hint is-danger" role="alert">
              A quantized V cache only loads with flash attention on. Set flash attention to
              <strong> On</strong> above — leaving it at the server default is not enough, since
              that default may be off — or set the V cache back to the server default.
            </p>
          ) : null}

          {/* ---- llama.cpp knobs ---- */}
          <div className="mm-grid">
            <label className="mm-field">
              <span className="mm-field-label">CPU thread pool</span>
              <input
                className="mm-input tnum"
                type="number"
                min={1}
                max={64}
                step={1}
                placeholder="server default"
                value={threads === null ? '' : String(threads)}
                disabled={loading || mlx}
                onChange={(e) => {
                  const v = e.target.value.trim()
                  if (v === '') return setThreads(null)
                  const n = Number(v)
                  setThreads(Number.isFinite(n) ? Math.max(1, Math.round(n)) : null)
                }}
              />
              <span className="mm-hint">
                {mlx
                  ? 'llama.cpp only.'
                  : 'Inference here is GPU-bound; this rarely changes throughput.'}
              </span>
            </label>

            <div className="mm-field">
              <div className="mm-field-head">
                <span className="mm-field-label">GPU offload</span>
                <span className={offload === null ? 'mm-field-value is-unset' : 'mm-field-value tnum'}>
                  {offload === null ? 'server default' : `${Math.round(offload * 100)}%`}
                </span>
                {offload !== null ? (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => setOffload(null)}
                  >
                    Unset
                  </button>
                ) : null}
              </div>
              <input
                className="mm-range"
                type="range"
                min={0}
                max={1}
                step={0.05}
                aria-label="GPU offload ratio"
                value={offload ?? 1}
                disabled={loading || mlx}
                onChange={(e) => setOffload(Number(e.target.value))}
              />
              <span className="mm-hint">
                {mlx
                  ? 'llama.cpp only.'
                  : 'Fraction of layers on the GPU. Anything under 1 puts layers on the CPU and costs a lot of speed.'}
              </span>
            </div>
          </div>

          {/* ---- TTL ---- */}
          <label className="mm-field">
            <span className="mm-field-label">Idle TTL (minutes)</span>
            <input
              className="mm-input is-narrow tnum"
              type="number"
              min={1}
              step={1}
              placeholder="stays resident"
              value={ttlMinutes === null ? '' : String(ttlMinutes)}
              disabled={loading}
              onChange={(e) => {
                const v = e.target.value.trim()
                if (v === '') return setTtlMinutes(null)
                const n = Number(v)
                setTtlMinutes(Number.isFinite(n) ? Math.max(1, Math.round(n)) : null)
              }}
            />
            <span className="mm-hint">
              Empty keeps the model in memory until it is unloaded. A TTL lets the server evict
              it while idle, which silently changes the window the next request runs in.
            </span>
          </label>

          {/* ---- failure, verbatim ---- */}
          {failure !== null || error !== undefined ? (
            <div className="mm-alert is-danger">
              <span className="mm-alert-title">
                {failure !== null ? 'Load failed' : 'The server reported a problem'}
              </span>
              <pre className="mm-verbatim">{failure ?? error}</pre>
              <p className="mm-alert-body">
                That is the server’s own message, unedited. “Insufficient system resources”
                means the box could not fit this model alongside what is already resident.
              </p>
            </div>
          ) : null}

          {/* ---- in flight ---- */}
          {progress !== null ? (
            <div className="mm-progress">
              <div className="mm-progress-head">
                <span className="mm-progress-phase">{phaseWord(progress.phase)}</span>
                <span className="mm-progress-pct tnum">
                  {Math.round(clamp01(progress.progress) * 100)}%
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!loading}
                  onClick={onCancelLoad}
                >
                  Cancel
                </button>
              </div>
              <div
                className="mm-bar"
                role="progressbar"
                aria-label="Load progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(clamp01(progress.progress) * 100)}
              >
                <span
                  className="mm-bar-fill is-load"
                  style={{ width: `${clamp01(progress.progress) * 100}%` }}
                />
              </div>
              {progress.message ? (
                <span className="mm-flight-msg">{progress.message}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="mm-dlg-foot">
          <span className="mm-dlg-foot-note">
            {setCount === 0
              ? 'Nothing set — the server picks every value.'
              : `${setCount} ${setCount === 1 ? 'field' : 'fields'} will be sent; the rest are left to the server.`}
          </span>
          <button type="button" className="btn btn-sm" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={loading || blocked}
            title={blocked ? 'A quantized V cache needs flash attention on' : undefined}
            onClick={submit}
          >
            {loading ? 'Loading…' : 'Load model'}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}

export default LoadDialog
