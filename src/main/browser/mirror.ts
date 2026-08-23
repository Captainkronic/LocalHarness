/**
 * A live view of the browser the model is driving.
 *
 * The playwright server runs Chrome headless, so everything the model does in a
 * page — loading it, clicking, watching a game run — happens where nobody can
 * see it. The captured frames it hands to its vision model are a record after
 * the fact; they do not show a ball bouncing or a page scrolling.
 *
 * Chrome is already listening for DevTools on a known port, so this attaches to
 * the same browser and asks for a screencast. What arrives is what is on the
 * page, as it happens, without touching the model's own session: a screencast is
 * read-only and a second client on the same target is something CDP expects.
 *
 * Deliberately lazy and deliberately cheap. It connects only when someone is
 * looking, throttles to a rate a person can watch rather than the rate Chrome
 * can produce, and disconnects the moment the viewer goes away — an idle mirror
 * on a 60fps canvas is a lot of JPEG for nobody.
 */

import type { LogFn } from '../mcp/manager'

export interface BrowserMirrorOptions {
  /** DevTools port of the browser the playwright server drives. */
  getPort: () => number
  onFrame: (frame: { dataUrl: string; width: number; height: number; at: number }) => void
  onStatus: (status: BrowserMirrorStatus) => void
  onLog: LogFn
}

export type BrowserMirrorStatus = 'off' | 'connecting' | 'live' | 'unavailable'

const SCOPE = 'mirror'

/**
 * Frames per second delivered to the renderer.
 *
 * Twelve was enough to watch a page scroll and not enough to watch a game. A
 * shot fired and an invader hit inside the same twelfth of a second look like
 * one event, and the point of watching the model play is seeing what it is
 * reacting to.
 *
 * Twenty-four is the compromise: film rate, visibly continuous, and roughly a
 * megabyte a second of JPEG across IPC — which the app can afford while it is
 * the thing being looked at, and which stops entirely the moment nobody is
 * watching. Above this the renderer starts dropping frames anyway; it is
 * painting a conversation as well.
 */
const MAX_FPS = Number(process.env['LH_MIRROR_FPS'] ?? 24)
const MIN_GAP_MS = Math.floor(1000 / Math.max(1, Math.min(60, MAX_FPS)))
/* One repaint a second: fast enough to read as live, slow enough that a
   headless browser is not being asked to render flat out for a side panel. */
const POLL_MS = 1000
/* Base64 length below which a screencast frame is taken to be the headless
   blank rather than a picture. The measured blank was ~3,968 chars. */
const BLANK_FRAME_MAX_B64 = 6_000
/* Poll ticks between checks for a better target. Three seconds: long enough
   not to hammer /json/list, short enough that nobody watches a blank box. */
const RETARGET_EVERY = 3

/** Retry while a viewer is watching, backing off so a browser that is not
 *  running does not turn into a reconnect storm. */
const RETRY_START_MS = 1_000
const RETRY_MAX_MS = 15_000

export class BrowserMirror {
  private readonly o: BrowserMirrorOptions
  private ws: WebSocket | null = null
  private nextId = 1
  private watchers = 0
  private status: BrowserMirrorStatus = 'off'
  private lastFrameAt = 0
  /** Repaint pump. See startPolling — headless Chrome will not screencast. */
  private poll: ReturnType<typeof setInterval> | null = null
  private retryMs = RETRY_START_MS
  private retryTimer: NodeJS.Timeout | null = null
  private closing = false
  /** The page url currently mirrored, so a better one can be noticed later. */
  private attachedUrl = ''

  constructor(opts: BrowserMirrorOptions) {
    this.o = opts
  }

  /** A viewer opened a surface that shows the stream. */
  watch(): void {
    this.watchers += 1
    if (this.watchers === 1) {
      this.closing = false
      this.retryMs = RETRY_START_MS
      void this.connect()
      return
    }
    /*
     * A LATER viewer has to be told the state it is joining.
     *
     * setStatus only emits on a CHANGE, and the renderer resets its own copy to
     * 'off' whenever a viewer unmounts. The strip under the composer mounts and
     * unmounts as the model moves between browser and other tools, so a viewer
     * routinely arrives while main is already 'live' — and then nothing is ever
     * emitted, because from main's side nothing changed. The socket stays up,
     * frames keep flowing, and the panel sits on "opening the page" forever.
     *
     * Observed exactly that: an ESTABLISHED connection to the browser and a
     * panel insisting it was still opening one.
     */
    this.o.onStatus(this.status)
    // force: the newcomer has no frame at all, so the usual "do not paint over a
    // newer frame" guard would leave it staring at an empty box.
    if (this.status === 'live') this.seed(true)
  }

  /** A viewer looked away. The last one out turns the stream off. */
  unwatch(): void {
    this.watchers = Math.max(0, this.watchers - 1)
    if (this.watchers === 0) this.stop()
  }

  stop(): void {
    this.closing = true
    this.clearRetry()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        // Ask Chrome to stop producing frames before dropping the socket, so a
        // browser that outlives us is not left screencasting to nobody.
        ws.send(JSON.stringify({ id: this.nextId++, method: 'Page.stopScreencast' }))
        ws.close()
      } catch {
        /* already gone */
      }
    }
    this.setStatus('off')
  }

  private setStatus(next: BrowserMirrorStatus): void {
    if (this.status === next) return
    this.status = next
    this.o.onStatus(next)
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private scheduleRetry(): void {
    if (this.closing || this.watchers === 0) return
    this.clearRetry()
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs)
    this.retryMs = Math.min(RETRY_MAX_MS, Math.round(this.retryMs * 1.8))
  }

  private async connect(): Promise<void> {
    if (this.closing || this.watchers === 0 || this.ws) return
    const port = this.o.getPort()
    this.setStatus('connecting')

    /* Which target to mirror: the page the model is on. A browser with no page
       yet is not an error — it is a model that has not opened one. */
    let wsUrl: string | null = null
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = (await res.json()) as {
        type: string
        url?: string
        webSocketDebuggerUrl?: string
      }[]
      /*
       * Pick the page with something ON it, not merely the first page.
       *
       * This browser routinely has two page targets — the one being driven and
       * an about:blank left over from launch — and /json/list does not order
       * them predictably. Taking the first match therefore attached to
       * about:blank about half the time, and streamed a perfectly accurate
       * screenshot of nothing. The strip showed solid white while the Browser
       * tab beside it showed the real page, because the tab renders frames the
       * TOOL captured from the page it had just driven.
       *
       * Hours went into treating that white as a rendering fault. It never was:
       * the frame was honest and the target was wrong.
       */
      const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      const real = pages.find((t) => {
        const u = t.url ?? ''
        return u !== '' && u !== 'about:blank' && !u.startsWith('chrome://') && !u.startsWith('devtools://')
      })
      const chosen = real ?? pages[0]
      wsUrl = chosen?.webSocketDebuggerUrl ?? null
      this.attachedUrl = chosen?.url ?? ''
    } catch {
      wsUrl = null
    }
    if (!wsUrl) {
      this.setStatus('unavailable')
      this.scheduleRetry()
      return
    }

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch {
      this.setStatus('unavailable')
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.retryMs = RETRY_START_MS
      this.lastFrameAt = 0
      this.setStatus('live')
      this.send('Page.enable')
      this.send('Page.startScreencast', {
        // JPEG, not PNG: this is a moving picture, not a document, and PNG at
        // twelve frames a second is several megabytes a minute for no gain.
        format: 'jpeg',
        // Quality buys smoothness here rather than detail: this is a moving
        // picture watched at a distance, and the captured frames in the tab are
        // the ones anybody reads closely.
        quality: 45,
        maxWidth: 900,
        maxHeight: 680,
        everyNthFrame: 1
      })
      // Seed one frame immediately.
      //
      // A screencast only emits when something CHANGES, so attaching to a page
      // that has loaded and is sitting still produces nothing — the viewer gets
      // an empty box captioned "waiting for the page to change" while the page
      // is plainly showing something. One screenshot on connect fills it, and
      // the stream takes over from there.
      this.seed()
      this.startPolling()
    }

    ws.onmessage = (ev) => {
      let msg: { method?: string; params?: Record<string, unknown> }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.method !== 'Page.screencastFrame') return
      const params = msg.params ?? {}
      const sessionId = params.sessionId

      // Acknowledge EVERY frame, including ones we drop. Chrome stops sending
      // until the last one is acked, so skipping an ack to throttle does not
      // slow the stream down — it ends it.
      this.send('Page.screencastFrameAck', { sessionId })

      const now = Date.now()
      if (now - this.lastFrameAt < MIN_GAP_MS) return
      this.lastFrameAt = now

      const data = params.data
      if (typeof data !== 'string' || data.length === 0) return
      /*
       * Drop the blank frames headless Chrome sends.
       *
       * With --headless=new there is no surface being presented, and the
       * screencast returns solid white: one measured out of the running app was
       * 2,976 bytes for 806x457, which is about 0.05 bits a pixel. Anything with
       * a page in it is an order of magnitude larger. Without this the strip
       * flickers, because a white screencast frame and a good polled frame take
       * turns painting.
       *
       * A page that really is blank loses nothing: the poll below supplies the
       * same white picture a moment later, honestly.
       */
      if (data.length < BLANK_FRAME_MAX_B64) return
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number }
      this.o.onFrame({
        dataUrl: `data:image/jpeg;base64,${data}`,
        width: Math.round(meta.deviceWidth ?? 0),
        height: Math.round(meta.deviceHeight ?? 0),
        at: now
      })
    }

    const drop = (): void => {
      this.stopPolling()
      if (this.ws === ws) this.ws = null
      if (this.closing || this.watchers === 0) return
      this.setStatus('unavailable')
      this.scheduleRetry()
    }
    ws.onclose = drop
    ws.onerror = drop
  }

  /**
   * Ask for a repaint on a timer, because the screencast cannot be relied on.
   *
   * Page.startScreencast streams what the compositor is already presenting. The
   * browser this attaches to runs --headless=new, where there is no surface
   * being presented to anything, and the frames it sends back are BLANK — a
   * 2,976-byte JPEG of solid white at 806x457, verified by decoding one out of
   * the running app. Page.captureScreenshot is different in exactly the way
   * that matters: it forces a render and returns what the page actually looks
   * like, which is why the captured frames in the Browser tab were always
   * perfect while the live strip beside them showed nothing.
   *
   * So the still that used to be a one-off seed becomes the stream. It costs a
   * JPEG a second at quality 45 against a browser that is already resident, and
   * only while somebody is watching — the mirror is reference counted and this
   * stops with the last viewer.
   *
   * The screencast is left running. Where it works it is cheaper and smoother
   * than this, its frames arrive on change rather than on a clock, and a real
   * frame arriving between polls simply wins on recency.
   */
  private startPolling(): void {
    this.stopPolling()
    let tick = 0
    this.poll = setInterval(() => {
      if (this.ws === null || this.watchers === 0) return
      this.seed(true)
      /*
       * Attaching once is not enough.
       *
       * The strip mounts as soon as the model reaches for the browser, which is
       * BEFORE the page it is about to open exists. At that moment the only
       * target is the launch-time about:blank, so that is what gets mirrored —
       * correctly, and uselessly — and it stays mirrored for the rest of the
       * run however much the model then does. Picking the right target is not
       * worth much if the right target has not been created yet.
       *
       * So the choice is revisited: while sitting on a blank, notice a real page
       * appearing and move to it.
       */
      tick += 1
      if (tick % RETARGET_EVERY === 0 && this.isBlankTarget()) void this.retarget()
    }, POLL_MS)
    this.poll.unref?.()
  }

  /** True while mirroring something with nothing on it. */
  private isBlankTarget(): boolean {
    const u = this.attachedUrl
    return u === '' || u === 'about:blank' || u.startsWith('chrome://') || u.startsWith('devtools://')
  }

  /** Drop a blank target once a real page exists, and let connect() re-pick. */
  private async retarget(): Promise<void> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.o.getPort()}/json/list`)
      const targets = (await res.json()) as { type: string; url?: string }[]
      const better = targets.some((t) => {
        if (t.type !== 'page') return false
        const u = t.url ?? ''
        return u !== '' && u !== 'about:blank' && !u.startsWith('chrome://') && !u.startsWith('devtools://')
      })
      if (!better) return
      this.o.onLog('info', SCOPE, 'a real page appeared; moving the mirror off about:blank')
      const ws = this.ws
      this.ws = null
      this.stopPolling()
      try {
        ws?.close()
      } catch {
        /* the reconnect below does not depend on a clean close */
      }
      void this.connect()
    } catch {
      /* the next tick tries again */
    }
  }

  private stopPolling(): void {
    if (this.poll !== null) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  /** One still, so the view is never empty while a page is up. */
  private seed(force = false): void {
    const ws = this.ws
    if (!ws) return
    const id = this.nextId++
    const onSeed = (ev: MessageEvent): void => {
      let msg: { id?: number; result?: { data?: string } }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id !== id) return
      ws.removeEventListener('message', onSeed)
      const data = msg.result?.data
      if (typeof data !== 'string' || data.length === 0) return
      // Only if the live stream has not already produced something: a real
      // frame is newer and this must not paint over it. A forced seed is for a
      // viewer that joined late and holds no frame of its own, where "newer"
      // means nothing — it has nothing to be newer than.
      if (!force && this.lastFrameAt !== 0) return
      this.lastFrameAt = Date.now()
      this.o.onFrame({
        dataUrl: `data:image/jpeg;base64,${data}`,
        width: 0,
        height: 0,
        at: this.lastFrameAt
      })
    }
    ws.addEventListener('message', onSeed)
    try {
      ws.send(JSON.stringify({ id, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 45 } }))
    } catch {
      ws.removeEventListener('message', onSeed)
    }
  }

  private send(method: string, params: Record<string, unknown> = {}): void {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify({ id: this.nextId++, method, params }))
    } catch (err) {
      this.o.onLog('warn', SCOPE, `could not send ${method}: ${String(err)}`)
    }
  }
}
