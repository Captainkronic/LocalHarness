import { useState, type JSX } from 'react'
import type { CatalogModel } from '@shared/types'
import { formatBytes, formatTokens } from '@renderer/lib/format'
import './models.css'

/**
 * One model the server knows about. Dense by design — this list is long and is
 * scanned, not read.
 *
 * A model with several quant variants gets a picker: the variant is what is
 * actually loaded, and picking the wrong quant is the difference between a model
 * that fits in the working set and one that does not.
 */

export interface CatalogRowProps {
  model: CatalogModel
  /** Blocks the Load button — a load is already in flight, or control is down. */
  disabled?: boolean
  /** Receives the variant key, which may carry an `@quant` suffix. */
  onLoad: (modelKey: string) => void
}

/** "qwen/qwen3.6-27b@q4_k_xl" -> "q4_k_xl"; keys without a suffix stay whole. */
function variantLabel(variant: string): string {
  const at = variant.indexOf('@')
  return at === -1 ? variant : variant.slice(at + 1)
}

function isMlx(format: string): boolean {
  return format.toLowerCase().includes('mlx')
}

function DownloadIcon(): JSX.Element {
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
      <path d="M8 3v7" />
      <path d="M5 7.5 8 10.5l3-3" />
      <path d="M3 13h10" />
    </svg>
  )
}

export function CatalogRow({ model, disabled, onLoad }: CatalogRowProps): JSX.Element {
  const [variant, setVariant] = useState(
    () => model.selectedVariant ?? model.variants[0] ?? model.modelKey
  )

  const resident = model.loadedIdentifiers.length > 0
  const mlx = isMlx(model.format)
  const hasVariants = model.variants.length > 1

  return (
    <div className={resident ? 'mm-row is-resident' : 'mm-row'}>
      <div className="mm-row-main">
        <div className="mm-row-title">
          <span className="mm-row-name" title={model.modelKey}>
            {model.displayName}
          </span>
          <span className="mm-row-pub">{model.publisher}</span>
          <span className={`mm-badge ${mlx ? 'is-mlx' : 'is-gguf'}`}>{model.format}</span>
        </div>

        <div className="mm-facts">
          {model.quantization ? (
            <span className="mm-fact">
              <span className="mm-fact-k">quant</span>
              <span className="mm-fact-v">{model.quantization}</span>
            </span>
          ) : null}
          <span className="mm-fact">
            <span className="mm-fact-k">params</span>
            <span className="mm-fact-v tnum">{model.paramsString || '—'}</span>
          </span>
          <span className="mm-fact">
            <span className="mm-fact-k">size</span>
            <span className="mm-fact-v tnum">{formatBytes(model.sizeBytes)}</span>
          </span>
          <span className="mm-fact" title="Architectural ceiling, not a window it will load with">
            <span className="mm-fact-k">max ctx</span>
            <span className="mm-fact-v tnum">{formatTokens(model.maxContextLength)}</span>
          </span>
          {model.vision ? <span className="chip">vision</span> : null}
          {model.trainedForToolUse ? <span className="chip">tool use</span> : null}
        </div>
      </div>

      <div className="mm-row-actions">
        {hasVariants && !resident ? (
          <select
            className="mm-variant"
            value={variant}
            aria-label={`Variant of ${model.displayName}`}
            title="Which quant variant to load"
            onChange={(e) => setVariant(e.target.value)}
          >
            {model.variants.map((v) => (
              <option key={v} value={v}>
                {variantLabel(v)}
              </option>
            ))}
          </select>
        ) : null}

        {resident ? (
          <span className="chip is-live" title={model.loadedIdentifiers.join('\n')}>
            <span className="dot dot-ok" />
            loaded
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-sm"
            disabled={disabled === true}
            onClick={() => onLoad(variant)}
          >
            <DownloadIcon />
            Load
          </button>
        )}
      </div>
    </div>
  )
}

export default CatalogRow
