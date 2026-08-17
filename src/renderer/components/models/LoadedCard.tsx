import { useEffect, useState, type JSX } from 'react'
import type { LoadedInstance } from '@shared/types'
import { clamp01, formatBytes, formatMs, formatPercent, relativeTime } from '@renderer/lib/format'
import './models.css'

/**
 * One resident model.
 *
 * The headline number is the window it was actually loaded with, not the
 * architectural ceiling — the ceiling is usually several times larger and is the
 * number people confuse it with. So the loaded figure is set large in the
 * context hue and the maximum trails it in muted text.
 *
 * Unload is destructive in a way the UI has to respect: evicting a 27B model
 * costs minutes to undo and there is no undo, so the button confirms in place.
 */

export interface LoadedCardProps {
  instance: LoadedInstance
  /** True while an unload for this instance is in flight. */
  busy?: boolean
  onUnload: (identifier: string) => void
}

/** Full digits with separators. Windows are compared against each other here,
 *  so "76,032 / 262,144" has to be readable — "76.0k / 262k" hides the point. */
function fullCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function isMlx(format: string): boolean {
  return format.toLowerCase().includes('mlx')
}

function EjectIcon(): JSX.Element {
  return (
    <svg
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
      <path d="M8 2.5 13 9H3l5-6.5Z" />
      <path d="M3 12.5h10" />
    </svg>
  )
}

export function LoadedCard({ instance, busy, onUnload }: LoadedCardProps): JSX.Element {
  const [confirming, setConfirming] = useState(false)

  // A refresh that removes and re-adds the card must not leave it armed.
  useEffect(() => {
    setConfirming(false)
  }, [instance.identifier])

  const max = instance.maxContextLength > 0 ? instance.maxContextLength : null
  const fraction = max === null ? null : clamp01(instance.contextLength / max)
  const mlx = isMlx(instance.format)

  return (
    <article className="mm-card" data-busy={busy === true}>
      <header className="mm-card-head">
        <div className="mm-card-ident">
          <div className="mm-card-title">
            <span className="mm-card-name" title={instance.displayName}>
              {instance.displayName}
            </span>
            <span className={`mm-badge ${mlx ? 'is-mlx' : 'is-gguf'}`}>{instance.format}</span>
            {instance.quantization ? (
              <span className="chip">
                {instance.quantization}
                {instance.quantBits !== null ? ` · ${instance.quantBits}-bit` : ''}
              </span>
            ) : null}
          </div>
          <span className="mm-card-key" title={instance.modelKey}>
            {instance.modelKey}
          </span>
        </div>

        <div className="mm-card-actions">
          {confirming ? null : (
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy === true}
              onClick={() => setConfirming(true)}
            >
              <EjectIcon />
              Unload
            </button>
          )}
        </div>
      </header>

      <div className="mm-ctx">
        <div className="mm-ctx-line">
          <span className="mm-ctx-label">Loaded context</span>
          <span className="mm-ctx-pct tnum">{formatPercent(fraction)} of max</span>
        </div>
        <div className="mm-ctx-line">
          <span className="mm-ctx-loaded tnum">{fullCount(instance.contextLength)}</span>
          <span className="mm-ctx-of">/</span>
          <span className="mm-ctx-max tnum">{max === null ? '—' : fullCount(max)}</span>
          <span className="mm-ctx-of">architectural max</span>
        </div>
        <div
          className="mm-bar"
          role="progressbar"
          aria-label="Loaded window against architectural maximum"
          aria-valuemin={0}
          aria-valuemax={max ?? undefined}
          aria-valuenow={instance.contextLength}
          aria-valuetext={`${instance.contextLength} of ${max ?? 'unknown'} tokens`}
        >
          <span
            className="mm-bar-fill"
            style={{ width: `${(fraction ?? 0) * 100}%` }}
          />
        </div>
        <p className="mm-ctx-note">
          The left number is the only one requests are measured against. The right one is
          what the architecture allows, not what this instance can take.
        </p>
      </div>

      <div className="mm-facts">
        <span className="mm-fact">
          <span className="mm-fact-k">publisher</span>
          <span className="mm-fact-v">{instance.publisher || '—'}</span>
        </span>
        <span className="mm-fact">
          <span className="mm-fact-k">params</span>
          <span className="mm-fact-v tnum">{instance.paramsString || '—'}</span>
        </span>
        <span className="mm-fact">
          <span className="mm-fact-k">size</span>
          <span className="mm-fact-v tnum">{formatBytes(instance.sizeBytes)}</span>
        </span>
        <span className="mm-fact">
          <span className="mm-fact-k">arch</span>
          <span className="mm-fact-v">{instance.architecture || '—'}</span>
        </span>
        <span className="mm-fact">
          <span className="mm-fact-k">last used</span>
          <span className="mm-fact-v">
            {instance.lastUsedTime === null ? 'not yet' : relativeTime(instance.lastUsedTime)}
          </span>
        </span>
      </div>

      <div className="mm-chips">
        {instance.vision ? <span className="chip">vision</span> : null}
        {instance.trainedForToolUse ? <span className="chip">tool use</span> : null}
        <span
          className="chip tnum"
          title={
            instance.ttlMs === null
              ? 'No TTL was set, so the server will keep this model in memory until it is unloaded.'
              : 'The server evicts this model after it has been idle this long.'
          }
        >
          {instance.ttlMs === null ? 'no idle eviction' : `idle TTL ${formatMs(instance.ttlMs)}`}
        </span>
      </div>

      {confirming ? (
        <div className="mm-confirm" role="alertdialog" aria-label="Confirm unload">
          <span className="mm-confirm-text">
            Unload <strong>{instance.displayName}</strong>? It frees{' '}
            <span className="tnum">{formatBytes(instance.sizeBytes)}</span>, and reloading it
            with the same window takes minutes. There is no undo.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setConfirming(false)}
          >
            Keep it
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy === true}
            onClick={() => {
              setConfirming(false)
              onUnload(instance.identifier)
            }}
          >
            Unload now
          </button>
        </div>
      ) : null}
    </article>
  )
}

export default LoadedCard
