import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import type { CatalogModel, ControlStatus, LoadOptions } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { clamp01, relativeTime } from '@renderer/lib/format'
import LoadedCard from './LoadedCard'
import CatalogRow from './CatalogRow'
import LoadDialog from './LoadDialog'
import './models.css'

/**
 * Remote model control.
 *
 * This screen is the only place in the app that can move memory on the Mac
 * Studio, so it is built around three facts:
 *
 *  - Load and unload run over a websocket to LM Studio's own port. HTTP cannot
 *    carry them, and neither can the relay in front of it, so an unavailable
 *    connection gets a real explanation rather than a status word.
 *  - The loaded window and the architectural maximum are different numbers, and
 *    only the first one constrains a request.
 *  - The box fits one large model. Every path that would evict one says so
 *    first.
 */

export interface ModelManagerProps {
  open: boolean
  onClose: () => void
}

type FormatFilter = 'all' | 'gguf' | 'mlx'

const FORMAT_FILTERS: ReadonlyArray<{ id: FormatFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'gguf', label: 'GGUF' },
  { id: 'mlx', label: 'MLX' }
]

/** Variant keys carry an `@quant` suffix; a resident instance reports the bare
 *  key, so the two only compare on the part before the `@`. */
function baseKey(key: string): string {
  const at = key.indexOf('@')
  return at === -1 ? key : key.slice(0, at)
}

function matchesFormat(format: string, filter: FormatFilter): boolean {
  if (filter === 'all') return true
  return format.toLowerCase().includes(filter)
}

function statusDot(status: ControlStatus): string {
  switch (status) {
    case 'connected':
      return 'dot dot-ok'
    case 'connecting':
      return 'dot dot-busy'
    case 'unavailable':
      return 'dot dot-error'
    default:
      return 'dot dot-warn'
  }
}

function statusWord(status: ControlStatus): string {
  switch (status) {
    case 'connected':
      return 'connected'
    case 'connecting':
      return 'connecting…'
    case 'unavailable':
      return 'unavailable'
    default:
      return 'not connected'
  }
}

/** Best guess at the address that would work, from the API root already in
 *  settings. Shown as guidance, never applied automatically. */
function suggestControlUrl(nativeApiUrl: string): string | null {
  try {
    const u = new URL(nativeApiUrl)
    return `ws://${u.hostname}:1235/llm`
  } catch {
    return null
  }
}

function RefreshIcon({ spinning }: { spinning: boolean }): JSX.Element {
  return (
    <svg
      className={spinning ? 'mm-spin' : undefined}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8a5 5 0 1 1-1.6-3.66" />
      <path d="M13 2.5V5.5h-3" />
    </svg>
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

export function ModelManager({ open, onClose }: ModelManagerProps): JSX.Element | null {
  const control = useStore((s) => s.control)
  const nativeApiUrl = useStore((s) => s.settings.nativeApiUrl)
  const refreshControl = useStore((s) => s.refreshControl)
  const loadModel = useStore((s) => s.loadModel)
  const unloadModel = useStore((s) => s.unloadModel)
  const cancelLoad = useStore((s) => s.cancelLoad)

  const [filter, setFilter] = useState('')
  const [format, setFormat] = useState<FormatFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(() => new Set<string>())
  /** The catalog entry and variant key the load dialog is open for. */
  const [target, setTarget] = useState<{ model: CatalogModel; modelKey: string } | null>(null)
  /** Verbatim failure from the last load/unload. The control state carries its
   *  own connection-level error; this one is about the action just attempted. */
  const [actionError, setActionError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refreshControl()
    } finally {
      setRefreshing(false)
    }
  }, [refreshControl])

  // Opening is the moment the list has to be true; nothing else polls this.
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Layered: the load dialog goes first, then the manager.
      e.stopPropagation()
      if (target !== null) setTarget(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, target])

  const markBusy = useCallback((identifier: string, on: boolean): void => {
    setBusyIds((prev) => {
      const next = new Set(prev)
      if (on) next.add(identifier)
      else next.delete(identifier)
      return next
    })
  }, [])

  /** Returns whether the eviction actually happened, so callers that depend on
   *  the memory being free can stop rather than guess. */
  const handleUnload = useCallback(
    async (identifier: string): Promise<boolean> => {
      setActionError(null)
      markBusy(identifier, true)
      try {
        const res = await unloadModel(identifier)
        if (!res.ok) {
          setActionError(res.error ?? 'The unload failed and the server gave no message.')
        }
        return res.ok
      } finally {
        markBusy(identifier, false)
      }
    },
    [markBusy, unloadModel]
  )

  const handleLoad = useCallback(
    async (modelKey: string, options: LoadOptions): Promise<void> => {
      setActionError(null)
      const res = await loadModel(modelKey, options)
      if (!res.ok) {
        setActionError(res.error ?? 'The load failed and the server gave no message.')
      }
    },
    [loadModel]
  )

  /** The eviction path. If the unload fails there is no point starting a load
   *  that needs the freed memory — it would sit there for minutes and come back
   *  with "insufficient system resources". */
  const handleUnloadThenLoad = useCallback(
    async (identifier: string, modelKey: string, options: LoadOptions): Promise<void> => {
      const freed = await handleUnload(identifier)
      if (!freed) return
      await handleLoad(modelKey, options)
    },
    [handleUnload, handleLoad]
  )

  const catalog = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matches = (m: CatalogModel): boolean => {
      if (!matchesFormat(m.format, format)) return false
      if (q === '') return true
      return [m.displayName, m.modelKey, m.publisher, m.quantization, m.architecture]
        .join(' ')
        .toLowerCase()
        .includes(q)
    }
    return control.catalog.filter(matches).sort((a, b) => {
      const ar = a.loadedIdentifiers.length > 0 ? 0 : 1
      const br = b.loadedIdentifiers.length > 0 ? 0 : 1
      if (ar !== br) return ar - br
      return a.displayName.localeCompare(b.displayName)
    })
  }, [control.catalog, filter, format])

  // The dialog's job is done the moment the model is actually resident.
  useEffect(() => {
    if (target === null) return
    const wanted = baseKey(target.modelKey)
    if (control.loaded.some((i) => baseKey(i.modelKey) === wanted)) setTarget(null)
  }, [control.loaded, target])

  if (!open) return null

  const inFlight = control.inFlight
  const loading = inFlight !== null && inFlight.phase !== 'error'
  const suggested = suggestControlUrl(nativeApiUrl)
  const controlUsable = control.status === 'connected'
  /** doRefresh prefixes a failed catalog fetch with "catalog: ". Anything else
   *  in control.error is a socket problem and belongs to the header, not here. */
  const catalogError = control.error?.startsWith('catalog: ')
    ? control.error.slice('catalog: '.length)
    : null

  return createPortal(
    /* The load dialog is a sibling of the scrim, not a child: React events
     * bubble through the component tree even across a portal, so nesting it
     * would make every click inside it close the manager underneath. */
    <>
      <div className="mm-scrim" role="presentation" onMouseDown={onClose}>
        <div
          className="mm-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Model management"
          tabIndex={-1}
          ref={panelRef}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="mm-head">
            <h2 className="mm-title">Models</h2>

            <span
              className="mm-conn"
              title={`Model control websocket\n${control.url || 'no URL'}`}
            >
              <span className={statusDot(control.status)} />
              <span className="mm-url">{control.url || 'no control URL'}</span>
              <span className="mm-conn-word">{statusWord(control.status)}</span>
            </span>

            <span className="mm-head-spacer" />

            <span className="mm-count tnum">
              {control.lastRefreshedAt > 0 ? relativeTime(control.lastRefreshedAt) : 'never read'}
            </span>

            <div className="mm-head-actions">
              <button
                type="button"
                className="btn btn-sm"
                disabled={refreshing}
                onClick={() => void refresh()}
              >
                <RefreshIcon spinning={refreshing} />
                Refresh
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                aria-label="Close model management"
                onClick={onClose}
              >
                <XIcon />
                Esc
              </button>
            </div>
          </header>

          <div className="mm-body scroll-y">
            {control.status === 'unavailable' ? (
              <section className="mm-section">
                <div className="mm-alert is-danger">
                  <span className="mm-alert-title">Model control is not available</span>
                  <p className="mm-alert-body">
                    Loading and unloading are not part of the HTTP API — LM Studio only exposes
                    them over a websocket at <code>ws://&lt;host&gt;:1235/llm</code>, and that
                    websocket has to reach LM Studio directly. A relay in front of it cannot
                    carry the connection: the Python bridge on port 1234 answers a websocket
                    upgrade with <code>200 OK</code> instead of{' '}
                    <code>101 Switching Protocols</code>, so the handshake never completes and
                    retrying will not change that.
                  </p>
                  <ul className="mm-steps">
                    <li>
                      Point the native API root in Settings at the Studio&rsquo;s own LM Studio
                      port — <code>{suggested ?? 'ws://<host>:1235/llm'}</code> is the address
                      this app would then use.
                    </li>
                    <li>
                      Check LM Studio&rsquo;s own server is running on that port and reachable
                      from this machine.
                    </li>
                    <li>Refresh once the address is corrected.</li>
                  </ul>
                  {control.error ? <pre className="mm-verbatim">{control.error}</pre> : null}
                  <p className="mm-alert-body">
                    Everything else keeps working over HTTP — chat, telemetry and the model list
                    are unaffected. Only load and unload need this connection.
                  </p>
                  <div className="mm-alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={refreshing}
                      onClick={() => void refresh()}
                    >
                      <RefreshIcon spinning={refreshing} />
                      Try again
                    </button>
                  </div>
                </div>
              </section>
            ) : control.status === 'disconnected' ? (
              <section className="mm-section">
                <div className="mm-alert">
                  <span className="mm-alert-title">Not connected</span>
                  <p className="mm-alert-body">
                    The control websocket is closed, so the lists below are whatever was last
                    read. Refresh to reconnect.
                  </p>
                  {control.error ? <pre className="mm-verbatim">{control.error}</pre> : null}
                </div>
              </section>
            ) : control.error ? (
              <section className="mm-section">
                <div className="mm-alert is-danger">
                  <span className="mm-alert-title">The server reported a problem</span>
                  <pre className="mm-verbatim">{control.error}</pre>
                </div>
              </section>
            ) : null}

            {actionError !== null && target === null ? (
              <section className="mm-section">
                <div className="mm-alert is-danger">
                  <span className="mm-alert-title">That request failed</span>
                  <pre className="mm-verbatim">{actionError}</pre>
                  <div className="mm-alert-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setActionError(null)}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={refreshing}
                      onClick={() => void refresh()}
                    >
                      <RefreshIcon spinning={refreshing} />
                      Re-read state
                    </button>
                  </div>
                </div>
              </section>
            ) : null}

            {/* A load outlives the dialog, so it stays visible and cancellable. */}
            {inFlight !== null && target === null ? (
              <section className="mm-section">
                <div className="mm-flight">
                  <div className="mm-flight-line">
                    <span className="mm-flight-key" title={inFlight.modelKey}>
                      {inFlight.phase === 'error' ? 'Load failed: ' : 'Loading '}
                      {inFlight.modelKey}
                    </span>
                    <span className="mm-flight-pct tnum">
                      {Math.round(clamp01(inFlight.progress) * 100)}%
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={!loading}
                      onClick={() => void cancelLoad()}
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
                    aria-valuenow={Math.round(clamp01(inFlight.progress) * 100)}
                  >
                    <span
                      className="mm-bar-fill is-load"
                      style={{ width: `${clamp01(inFlight.progress) * 100}%` }}
                    />
                  </div>
                  {inFlight.message ? (
                    <span className="mm-flight-msg">{inFlight.message}</span>
                  ) : null}
                </div>
              </section>
            ) : null}

            {/* ---- resident ---- */}
            <section className="mm-section">
              <div className="mm-section-head">
                <span className="section-label">Resident</span>
                <span className="mm-count tnum">{control.loaded.length} in memory</span>
              </div>

              {control.loaded.length === 0 ? (
                <p className="mm-empty">
                  Nothing is resident. The server is holding no weights in memory, so the next
                  request will JIT-load a model with whatever window the server picks — load one
                  deliberately below to choose that window yourself.
                </p>
              ) : (
                <div className="mm-cards">
                  {control.loaded.map((instance) => (
                    <LoadedCard
                      key={instance.identifier}
                      instance={instance}
                      busy={busyIds.has(instance.identifier)}
                      onUnload={(id) => void handleUnload(id)}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* ---- catalog ---- */}
            <section className="mm-section">
              <div className="mm-section-head">
                <span className="section-label">Available</span>
                <span className="mm-count tnum">
                  {catalog.length === control.catalog.length
                    ? `${catalog.length} models`
                    : `${catalog.length} of ${control.catalog.length}`}
                </span>
              </div>

              <div className="mm-filters">
                <input
                  className="mm-search"
                  type="search"
                  placeholder="Filter by name, publisher, quant…"
                  spellCheck={false}
                  autoComplete="off"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <div className="mm-seg" role="radiogroup" aria-label="Format">
                  {FORMAT_FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="radio"
                      aria-checked={format === f.id}
                      className={format === f.id ? 'mm-seg-btn is-on' : 'mm-seg-btn'}
                      onClick={() => setFormat(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {control.catalog.length === 0 ? (
                <p className="mm-empty">
                  {/* The catalog comes over plain HTTP (/api/v1/models), NOT the
                      control websocket — blaming the socket sent the user to fix
                      the wrong thing. control.error carries the real reason,
                      prefixed "catalog:" when the fetch itself failed. */}
                  {catalogError !== null
                    ? `The model list could not be read from ${control.url === '' ? 'the server' : 'LM Studio'}: ${catalogError}`
                    : 'The server reported no models. LM Studio is reachable but has nothing indexed — check its models directory.'}
                </p>
              ) : catalog.length === 0 ? (
                <p className="mm-empty">
                  No model matches{' '}
                  {filter.trim() === ''
                    ? `the ${format.toUpperCase()} filter`
                    : `“${filter.trim()}”`}
                  . {control.catalog.length} models are known.
                </p>
              ) : (
                <div className="mm-rows">
                  {catalog.map((m) => (
                    <CatalogRow
                      key={m.modelKey}
                      model={m}
                      disabled={loading || !controlUsable}
                      onLoad={(modelKey) => {
                        setActionError(null)
                        setTarget({ model: m, modelKey })
                      }}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {target !== null ? (
        <LoadDialog
          model={target.model}
          modelKey={target.modelKey}
          resident={control.loaded}
          progress={inFlight}
          error={actionError ?? control.error}
          onLoad={(modelKey, options) => void handleLoad(modelKey, options)}
          onUnloadThenLoad={(identifier, modelKey, options) =>
            void handleUnloadThenLoad(identifier, modelKey, options)
          }
          onCancelLoad={() => void cancelLoad()}
          onClose={() => setTarget(null)}
        />
      ) : null}
    </>,
    document.body
  )
}

export default ModelManager
