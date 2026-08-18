/**
 * The macOS menu bar status item.
 *
 * Adam runs inference that takes minutes — an agentic Code turn, a two-minute
 * ComfyUI render — and watching it currently means keeping a 1440px window in
 * front of whatever else he is doing. This puts the two facts worth glancing at
 * (which model is resident, how fast it is decoding) next to the exo and GPU
 * readouts he already keeps up there.
 *
 * It is a passive observer. Everything here is read off events the app already
 * emits to the renderer, so there is no new IPC, no orchestrator surface, and no
 * second source of truth that could disagree with the in-app HUD.
 *
 * The honesty rules apply here as much as anywhere: a rate is shown only while
 * it is being measured. A frozen number in the menu bar is worse than no number,
 * because it is the one place you look WITHOUT the context that would tell you
 * it is stale.
 */

import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'

import type { IpcEventChannel, IpcEvents } from '@shared/ipc'
import type { LiveMetrics, ServerHealth } from '@shared/types'

export interface TrayDeps {
  /** Raise the window, recreating it if the user closed it. */
  onOpen: () => void
  onNewConversation: () => void
  /** Null when nothing is resident, so the item can disable itself. */
  residentModelId: () => string | null
  contextWindow: (modelId: string) => number | null
  unloadModel: (modelId: string) => void
}

export interface TrayHandle {
  /** Feed it an event the app was already sending to the renderer. */
  observe: <K extends IpcEventChannel>(channel: K, payload: IpcEvents[K]) => void
  destroy: () => void
}

/**
 * Rebuilding a Menu is not free and the title jitters if it changes faster than
 * the eye can read it. Live metrics arrive at roughly 4Hz; half that is plenty
 * for something glanced at.
 */
const UPDATE_MS = 500

/**
 * A llama head, drawn as a 32x32 mask rather than derived from build/icon.svg.
 *
 * Two reasons it is inline PNG and not the SVG. Electron's `nativeImage` does
 * NOT decode SVG — a data URL of one yields an empty 0x0 image and `new Tray`
 * then shows nothing at all, which is exactly how the first attempt failed.
 * And `build/` is electron-builder's buildResources dir, not in `build.files`,
 * so an asset added there works in dev and vanishes when packaged.
 *
 * Drawn by hand because a 1024px icon downsampled to menu-bar size turns to
 * mush; at this scale a bold simple silhouette is the only thing that reads.
 * Black-on-transparent so `setTemplateImage` can recolour it for light and dark
 * menu bars and for the highlighted state.
 */
const ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42u2WOw4AIAhDuf+l6+KuqVT8lKRbtS8RghEXFbqyfFT46PJZnwGWAUB60iGgDkaCyoJpEAhFdzsT8gbA9mcoByhvwiPGUAEh3QHSfWCAcoBYBAgDGMBjqPiQZp85F+CPaqiugY3SAtOXAAAAAElFTkSuQmCC'

function trayIcon(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${ICON_PNG_BASE64}`)
  img.setTemplateImage(true)
  return img
}

/** Model ids are namespaced and long; the family name is what identifies it. */
function shortModel(id: string | null): string | null {
  if (!id) return null
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return tail.split('@')[0]
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function createTray(deps: TrayDeps): TrayHandle {
  const tray = new Tray(trayIcon())
  tray.setToolTip('CaptainLlama')

  let metrics: LiveMetrics | null = null
  let health: ServerHealth | null = null
  let lastTitle = ''
  let timer: NodeJS.Timeout | null = null

  /**
   * Decode rate, but only while it is actually being measured.
   *
   * `decodeTps` lingers on the last snapshot after a turn ends, so gating on the
   * phase rather than on the number is what keeps a finished turn's rate from
   * sitting in the menu bar looking live.
   */
  function liveRate(): number | null {
    if (metrics === null || metrics.phase !== 'decode') return null
    const tps = metrics.decodeTps
    return typeof tps === 'number' && tps > 0 ? tps : null
  }

  function render(): void {
    const model = shortModel(deps.residentModelId())
    const rate = liveRate()

    // Unreachable is worth saying, because the alternative is a model name that
    // implies everything is fine.
    const title =
      health !== null && !health.reachable
        ? 'offline'
        : model === null
          ? ''
          : rate !== null
            ? `${model} · ${rate.toFixed(1)} tok/s`
            : model

    if (title !== lastTitle) {
      tray.setTitle(title)
      lastTitle = title
    }

    const residentId = deps.residentModelId()
    const window = residentId ? deps.contextWindow(residentId) : null
    const used = metrics?.promptTokens ?? 0

    const info: MenuItemConstructorOptions[] = [
      {
        label: model ? `Resident: ${model}` : 'No model loaded',
        enabled: false
      }
    ]
    if (window !== null && used > 0) {
      info.push({
        label: `Context: ${formatTokens(used)} / ${formatTokens(window)}`,
        enabled: false
      })
    }
    if (rate !== null) {
      info.push({ label: `Decode: ${rate.toFixed(1)} tok/s`, enabled: false })
    }
    if (health !== null && !health.reachable) {
      info.push({ label: `Server unreachable — ${health.endpoint}`, enabled: false })
    }

    tray.setContextMenu(
      Menu.buildFromTemplate([
        ...info,
        { type: 'separator' },
        { label: 'Open CaptainLlama', click: () => deps.onOpen() },
        { label: 'New chat', accelerator: 'CmdOrCtrl+N', click: () => deps.onNewConversation() },
        {
          label: 'Unload model',
          enabled: residentId !== null,
          click: () => {
            if (residentId) deps.unloadModel(residentId)
          }
        },
        { type: 'separator' },
        // role, not app.exit(): the before-quit handler runs shutdown(), which
        // stops the live session, speech and every MCP child. Skipping it
        // orphans processes that then have to be hunted with pkill.
        { label: 'Quit CaptainLlama', role: 'quit' }
      ])
    )
  }

  /** Coalesce a burst of events into one repaint. */
  function schedule(): void {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      render()
    }, UPDATE_MS)
  }

  render()

  return {
    observe(channel, payload) {
      if (channel === 'event:liveMetrics') {
        metrics = payload as LiveMetrics
        schedule()
      } else if (channel === 'event:health') {
        health = payload as ServerHealth
        schedule()
      } else if (channel === 'event:models' || channel === 'event:controlState') {
        schedule()
      }
    },
    destroy() {
      if (timer !== null) clearTimeout(timer)
      tray.destroy()
    }
  }
}
