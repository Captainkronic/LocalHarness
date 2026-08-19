/**
 * What the model looked at.
 *
 * The browser it drives is headless, so when a Code turn opens a page, clicks
 * something and asks a vision model what happened, all of that is invisible:
 * the transcript shows a tool call and a paragraph of prose, and you have to
 * take its word for what was on screen. This shows the actual frames.
 *
 * Every frame here is the exact PNG that was handed to the vision model, not a
 * re-render — so if the model saw a blank page, you see a blank page, and the
 * disagreement between what it says and what it was looking at is visible
 * rather than assumed.
 *
 * Drawn from the tool's `structured` payload. The prose result does carry
 * `screenshot: /path.png`, and scraping it would have worked today and broken
 * the first time that header was reworded — that text is written for a model to
 * read, and is expected to change.
 */

import { useEffect, useMemo, useState, type JSX } from 'react'

import { useStore } from '@renderer/state/store'
import { useMirrorStream } from './useMirrorStream'
import './code.css'

interface Vision {
  model: string | null
  answer: string | null
  seconds: number | null
}

interface View {
  url: string
  title: string
  screenshot: string
  width: number
  height: number
  viewport: { width: number; height: number }
  truncatedPx: number
  vision: Vision | null
  header: string
  at: string
  /** Which tool produced it — added here, not by the server. */
  tool?: string
}

function asView(value: unknown): View | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.screenshot !== 'string' || v.screenshot.length === 0) return null
  if (typeof v.url !== 'string') return null
  return v as unknown as View
}

export function BrowserPane(): JSX.Element {
  const conversation = useStore((s) => s.conversation)
  const readImageDataUrl = useStore((s) => s.readImageDataUrl)
  const browserFrame = useStore((s) => s.browserFrame)
  const browserMirror = useStore((s) => s.browserMirror)
  const [selected, setSelected] = useState<number | null>(null)

  /* The stream runs only while this pane is mounted. Watching a headless
     browser nobody is looking at costs a JPEG every frame for nothing. */
  useMirrorStream()
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  /* Oldest first, so the filmstrip reads like the sequence of actions it was. */
  const views = useMemo(() => {
    const out: View[] = []
    for (const m of conversation?.messages ?? []) {
      for (const call of m.toolCalls ?? []) {
        if (call.status !== 'ok') continue
        const v = asView(call.structured)
        if (v) out.push({ ...v, tool: call.name.replace(/^.*__/, '') })
      }
    }
    return out
  }, [conversation])

  /* Follow the newest frame unless a frame was picked deliberately. */
  const index = selected ?? views.length - 1
  const current = index >= 0 ? views[index] : undefined

  /* Live only while following the newest frame. Picking an older capture is a
     deliberate act of looking back, and having it replaced by the live view a
     twelfth of a second later would make that impossible. */
  const live = selected === null && browserMirror === 'live' && browserFrame !== null

  useEffect(() => {
    let cancelled = false
    setMissing(false)
    if (!current) {
      setDataUrl(null)
      return
    }
    void readImageDataUrl(current.screenshot).then((url) => {
      if (cancelled) return
      // The shots directory is a cache and gets cleared; a frame from an older
      // conversation may simply be gone. Say so rather than showing a broken
      // image with no explanation.
      if (url) setDataUrl(url)
      else {
        setDataUrl(null)
        setMissing(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [current, readImageDataUrl])

  /* Only when there is NOTHING to show — no captures and no stream. The live
     view matters most in exactly the gap this early return used to cover: the
     model has a page open and is playing with it, and has not captured a frame
     yet, which is precisely when you want to watch. */
  if (views.length === 0 && !live) {
    return (
      <p className="pnl-empty">
        Nothing looked at yet. When the model opens a page or clicks something with the
        browser tools, you see the page live here, and every frame it was given.
      </p>
    )
  }

  return (
    <div className="bp">
      <header className="bp-head">
        <span className="bp-title">{current?.title || (live ? 'Live page' : 'Untitled page')}</span>
        <span className="bp-url" title={current?.url}>
          {current?.url}
        </span>
        {/* Says which of the two things you are looking at. A live view and a
            still capture look identical when the page happens to be static. */}
        <span className={live ? 'bp-live is-on' : 'bp-live'}>
          {live
            ? 'live'
            : browserMirror === 'connecting'
              ? 'connecting'
              : selected !== null
                ? 'captured frame'
                : browserMirror === 'unavailable'
                  ? 'browser not open'
                  : 'captured'}
        </span>
      </header>

      <div className="bp-stage">
        {live ? (
          <img className="bp-shot" src={browserFrame.dataUrl} alt="live browser view" />
        ) : dataUrl ? (
          <img className="bp-shot" src={dataUrl} alt={current?.title || 'page screenshot'} />
        ) : missing ? (
          <p className="bp-gone">
            This frame is no longer on disk — the browser cache was cleared since the
            model looked at it.
          </p>
        ) : (
          <p className="bp-gone">Loading frame…</p>
        )}
      </div>

      {live && browserFrame.width > 0 ? (
        <p className="bp-facts tnum">
          streaming · {browserFrame.width}×{browserFrame.height}
        </p>
      ) : current ? (
        <p className="bp-facts tnum">
          {current.tool} · {current.viewport.width}×{current.viewport.height} viewport ·{' '}
          {current.width}×{current.height} captured
          {current.truncatedPx > 0 ? ` · ${current.truncatedPx}px below the fold not captured` : ''}
        </p>
      ) : null}

      {/* What the vision model reported, beside the frame it reported on. The
          point of putting them together is that you can disagree with it. */}
      {current?.vision?.answer ? (
        <section className="bp-vision">
          <h4 className="bp-h">
            What it saw
            <span className="bp-model">
              {current.vision.model}
              {current.vision.seconds ? ` · ${current.vision.seconds}s` : ''}
            </span>
          </h4>
          <p>{current.vision.answer}</p>
        </section>
      ) : null}

      {views.length > 1 ? (
        <div className="bp-strip" role="tablist" aria-label="Frames">
          {views.map((v, i) => (
            <button
              key={`${v.screenshot}-${i}`}
              role="tab"
              aria-selected={i === index}
              className={i === index ? 'bp-frame is-on' : 'bp-frame'}
              title={`${v.tool} · ${v.title || v.url}`}
              onClick={() => setSelected(i === views.length - 1 ? null : i)}
            >
              {i + 1}
            </button>
          ))}
          {selected !== null ? (
            <button className="bp-follow" onClick={() => setSelected(null)}>
              follow newest
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default BrowserPane
