import type { CSSProperties, ReactElement } from 'react'
import { useStore } from '@renderer/state/store'
import { formatPercent, formatTokens, usageColor } from '@renderer/lib/format'
import './metrics.css'

type BreakdownKey = 'system' | 'tools' | 'messages' | 'attachments'

const SEGMENTS: ReadonlyArray<{ key: BreakdownKey; label: string; cls: string }> = [
  { key: 'system', label: 'System prompt', cls: 'mx-seg-sys' },
  { key: 'tools', label: 'Tool schemas', cls: 'mx-seg-tools' },
  { key: 'messages', label: 'Messages', cls: 'mx-seg-msgs' },
  { key: 'attachments', label: 'Attachments', cls: 'mx-seg-att' }
]

/**
 * Used-vs-window meter, segmented by what is actually eating the window.
 *
 * The denominator is the *loaded* context length, which LM Studio only reports
 * while the model is resident. When it is unknown we render em dashes — the
 * architectural maximum is not a substitute, it is usually several times the
 * window the model was actually loaded with.
 */
export function ContextMeter(): ReactElement {
  const usage = useStore((s) => s.usage)
  const warnAt = useStore((s) => s.settings.contextWarnFraction)
  const { used, max, fraction, breakdown, calibrated } = usage
  // Narrowed once, so every readout below agrees about whether we know the window.
  const maxTokens: number | null = max !== null && max > 0 ? max : null
  const known = maxTokens !== null
  const meter = usageColor(fraction, warnAt)

  return (
    <div className="mx-slot mx-ctx" tabIndex={0} style={{ '--meter': meter } as CSSProperties}>
      <span className="mx-label">ctx</span>

      <div
        className={`mx-ctx-bar${known ? '' : ' is-unknown'}`}
        role="progressbar"
        aria-label="Context window used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
        aria-valuetext={
          maxTokens !== null ? `${used} of ${maxTokens} tokens` : 'window size unknown'
        }
      >
        {SEGMENTS.map(({ key, cls }) => {
          const v = breakdown[key]
          if (maxTokens === null || v <= 0) return null
          return (
            <span
              key={key}
              className={`mx-ctx-seg ${cls}`}
              style={{ width: `${Math.min(100, (v / maxTokens) * 100)}%` }}
            />
          )
        })}
      </div>

      <span className="mx-ctx-read tnum">
        {maxTokens !== null ? `${formatTokens(used)} / ${formatTokens(maxTokens)}` : '— / —'}
      </span>
      {/* Clamped, like the bar above it at :54. An unclamped reading printed
          "139%" over a bar sitting at full — one of them had to be wrong, and
          a percentage of a window cannot exceed the window. Over-full is a real
          state and it is reported by ContextBanner, which has room to explain
          it; here it just pins. */}
      <span className="mx-ctx-pct tnum" title={fraction !== null && fraction > 1 ? 'Over the loaded window — the oldest exchanges will be dropped' : undefined}>
        {formatPercent(fraction === null ? null : Math.min(1, fraction))}
      </span>

      <div className="mx-pop" role="tooltip">
        <div className="mx-pop-head">
          <span className="section-label">context window</span>
          <span className="tnum mx-pop-total">
            {maxTokens !== null
              ? `${formatTokens(used)} / ${formatTokens(maxTokens)}`
              : `${formatTokens(used)} used`}
          </span>
        </div>
        <ul className="mx-pop-list">
          {SEGMENTS.map(({ key, label, cls }) => (
            <li key={key}>
              <i className={`mx-sw ${cls}`} aria-hidden="true" />
              <span className="mx-pop-k">{label}</span>
              <span className="tnum mx-pop-v">{formatTokens(breakdown[key])}</span>
              <span className="tnum mx-pop-p">
                {maxTokens !== null ? formatPercent(breakdown[key] / maxTokens) : '—'}
              </span>
            </li>
          ))}
        </ul>
        <p className="mx-pop-note">
          {known
            ? 'Denominator is the window the model was actually loaded with, as reported while it is resident.'
            : 'The model’s real context window is unknown until it is resident. LocalHarness will not fall back to the architectural maximum — that figure is usually several times the loaded window, so the percentage would be a comfortable lie.'}
        </p>
        {/* The denominator was always explained here; the numerator never was,
            and the numerator is a count of text this app has not tokenised. It
            read 29% low on a real run until the measured ratio was applied to
            it. Whether that correction is in force changes what this number
            means, so it is stated rather than implied. */}
        <p className="mx-pop-note">
          {calibrated
            ? 'Numerator is our own count, corrected by the measured gap between what we estimate and what this model’s server actually reports.'
            : 'Numerator is our own estimate. This model has not finished a turn yet, so there is no measured correction — expect it to read low on code, which tokenises worse than prose.'}
        </p>
      </div>
    </div>
  )
}

export default ContextMeter
