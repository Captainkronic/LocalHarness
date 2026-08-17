/**
 * In-app window capture.
 *
 * `webContents.capturePage()` renders the window's own surface, so it needs NO
 * Screen Recording permission — unlike the `screencapture` CLI, which silently
 * HANGS (it does not error) when the responsible app lacks the TCC grant. That
 * makes this the only reliable way to look at the UI from a script, and it is
 * useful to a human too.
 *
 * Two entry points:
 *   - Cmd+Shift+S while the app is focused, saved to ~/Pictures.
 *   - LH_SHOT_DIR set in the environment: capture automatically once the window
 *     has painted, then exit if LH_SHOT_EXIT=1. This is what automation uses.
 */

import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Log = (level: 'info' | 'warn' | 'error', scope: string, message: string) => void

const SCOPE = 'shot'

function stamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

async function capture(
  win: BrowserWindow | null,
  dir: string,
  name: string,
  log: Log
): Promise<string | null> {
  if (!win || win.isDestroyed()) {
    log('warn', SCOPE, 'no window to capture')
    return null
  }
  try {
    const image = await win.webContents.capturePage()
    if (image.isEmpty()) {
      log('warn', SCOPE, 'captured an empty image — the window may not have painted yet')
      return null
    }
    await mkdir(dir, { recursive: true })
    const file = join(dir, name)
    await writeFile(file, image.toPNG())
    log('info', SCOPE, `saved ${file}`)
    return file
  } catch (err) {
    log('error', SCOPE, `capture failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function setupScreenshots(getWindow: () => BrowserWindow | null, log: Log): void {
  const registered = globalShortcut.register('CommandOrControl+Shift+S', () => {
    const win = getWindow()
    // Only when the app is actually frontmost — a global shortcut that fires
    // while the user is in another app would be a surprise, not a feature.
    if (!win || !win.isFocused()) return
    void capture(win, join(homedir(), 'Pictures'), `LocalHarness-${stamp()}.png`, log).then(
      (file) => {
        if (file) shell.showItemInFolder(file)
      }
    )
  })
  if (!registered) {
    log('warn', SCOPE, 'could not register the Cmd+Shift+S screenshot shortcut')
  }
  app.on('will-quit', () => globalShortcut.unregister('CommandOrControl+Shift+S'))

  const dir = process.env['LH_SHOT_DIR']
  if (!dir) return

  // Automation path. Wait for the first paint, then a settle delay so streamed
  // content and CSS transitions have landed before the frame is taken.
  const delay = Number(process.env['LH_SHOT_AFTER_MS'] ?? 2500)
  const name = process.env['LH_SHOT_NAME'] ?? `shot-${stamp()}.png`
  const win = getWindow()
  /**
   * LH_SHOT_DRIVE runs a snippet in the renderer before the frame is taken.
   *
   * Most of what breaks in this app is only visible in a state you have to
   * REACH — a rejected send, an approval dialog, a failed render. Photographing
   * the idle screen finds the layout bugs and none of the behavioural ones, so
   * the driver has to be able to click and type.
   *
   * Errors are reported and then swallowed: a snippet that throws should give
   * back whatever the screen looks like at that moment, which is usually the
   * thing being investigated.
   */
  const drive = process.env['LH_SHOT_DRIVE']
  const run = (): void => {
    setTimeout(() => {
      const w = getWindow()
      const driven =
        drive && w
          ? w.webContents
              .executeJavaScript(`(async () => { ${drive} })()`, true)
              .then((r: unknown) => log('info', SCOPE, `drive ok${r === undefined ? '' : `: ${String(r)}`}`))
              .catch((err: unknown) => log('warn', SCOPE, `drive failed: ${String(err)}`))
          : Promise.resolve()

      void driven
        .then(() => new Promise((r) => setTimeout(r, Number(process.env['LH_SHOT_SETTLE_MS'] ?? 1200))))
        .then(() => capture(getWindow(), dir, name, log))
        .then(() => {
          if (process.env['LH_SHOT_EXIT'] === '1') app.quit()
        })
    }, Number.isFinite(delay) ? delay : 2500)
  }
  if (win) {
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', run)
    else run()
  }
}
