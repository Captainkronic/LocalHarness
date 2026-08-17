/**
 * The input. Grows with the text up to 40% of the viewport, sends on Enter (and
 * Cmd+Enter), newlines on Shift+Enter, and turns into a stop control for as
 * long as a turn is in flight.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import type { Attachment } from '@shared/types'
import { useStore } from '@renderer/state/store'
import { formatPercent, formatTokens } from '@renderer/lib/format'
import './chat.css'

export interface ComposerProps {
  /** Optional controlled text, so a suggestion chip can prefill the box. */
  value?: string
  onValueChange?: (v: string) => void
  /** Bump to pull focus into the textarea. */
  focusSignal?: number
}

export default function Composer({ value, onValueChange, focusSignal }: ComposerProps) {
  const send = useStore((s) => s.send)
  const cancel = useStore((s) => s.cancel)
  const phase = useStore((s) => s.live.phase)
  const conversation = useStore((s) => s.conversation)
  const settings = useStore((s) => s.settings)
  const health = useStore((s) => s.health)
  const usage = useStore((s) => s.usage)

  const [internal, setInternal] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)

  const text = value ?? internal
  const setText = useCallback(
    (v: string) => {
      setInternal(v)
      onValueChange?.(v)
    },
    [onValueChange]
  )

  const running = phase !== 'idle'
  const activeModel = conversation?.modelId ?? settings.defaultModelId ?? health.residentModelId
  const canSend =
    !running && activeModel !== null && (text.trim() !== '' || attachments.length > 0)

  const overBudget =
    usage.fraction !== null && usage.fraction > settings.contextWarnFraction

  /* --- auto-grow --- */
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = Math.round(window.innerHeight * 0.4)
    const next = Math.min(el.scrollHeight, max)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
  }, [text])

  useEffect(() => {
    if (focusSignal === undefined) return
    const el = taRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [focusSignal])

  const submit = useCallback(() => {
    if (!canSend) return
    const body = text.trim()
    const files = attachments
    setText('')
    setAttachments([])
    void send(body, files.length > 0 ? files : undefined)
  }, [canSend, text, attachments, send, setText])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter') return
    if (e.nativeEvent.isComposing) return
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      submit()
      return
    }
    if (!e.shiftKey && !e.altKey) {
      e.preventDefault()
      submit()
    }
  }

  const attach = (): void => {
    void window.harness.invoke('chat:attachFiles').then((picked) => {
      if (picked.length === 0) return
      setAttachments((prev) => [
        ...prev,
        ...picked.filter((p) => !prev.some((existing) => existing.id === p.id))
      ])
    })
  }

  return (
    <div className="composer">
      <div className="composer-inner chat-measure">
        {overBudget ? (
          <div className="composer-warn">
            <span className="dot dot-warn" />
            <span className="tnum">
              Context at {formatPercent(usage.fraction)} of the window (
              {formatTokens(usage.used)} / {formatTokens(usage.max)})
            </span>
            <span>— older turns will start to cost you.</span>
          </div>
        ) : null}

        {attachments.length > 0 ? (
          <div className="composer-atts">
            {attachments.map((a) => (
              <span className="att-chip" key={a.id} title={a.path}>
                {a.kind === 'image' && a.dataUrl !== undefined ? (
                  <img src={a.dataUrl} alt="" />
                ) : null}
                <span className="att-name">{a.name}</span>
                <span className="att-tokens tnum">{formatTokens(a.tokens)}</span>
                <button
                  type="button"
                  className="att-x"
                  aria-label={`Remove ${a.name}`}
                  onClick={() =>
                    setAttachments((prev) => prev.filter((x) => x.id !== a.id))
                  }
                >
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
                    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div className="composer-box">
          <button
            type="button"
            className="composer-icon-btn"
            onClick={attach}
            disabled={running}
            title="Attach files"
            aria-label="Attach files"
          >
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
              <path d="M10.5 5L5.9 9.6a1.6 1.6 0 002.2 2.3l4.7-4.7a3 3 0 00-4.2-4.2L3.7 7.8a4.3 4.3 0 006 6.1L14 9.7" />
            </svg>
          </button>

          <textarea
            ref={taRef}
            className="composer-text"
            rows={1}
            value={text}
            placeholder={
              activeModel === null ? 'No model available' : 'Send a message…'
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
          />

          {running ? (
            <button
              type="button"
              className="composer-stop"
              onClick={() => cancel()}
              title="Stop generating"
              aria-label="Stop generating"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="4.5" y="4.5" width="7" height="7" rx="1" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className="composer-send"
              onClick={submit}
              disabled={!canSend}
              title="Send"
              aria-label="Send"
            >
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
                <path d="M8 12.5v-9M4 7.5L8 3.5l4 4" />
              </svg>
            </button>
          )}
        </div>

        <div className="composer-foot">
          {activeModel === null ? (
            <span className="composer-foot-nomodel">
              No model loaded — pick one in Settings or load it on the Mac Studio.
            </span>
          ) : (
            <span className="composer-foot-model" title={activeModel}>
              {activeModel}
            </span>
          )}
          <span className="composer-foot-hint">
            <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
          </span>
        </div>
      </div>
    </div>
  )
}
