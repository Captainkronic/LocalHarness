import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS, type IpcChannel, type IpcEventChannel } from '../shared/ipc'

/**
 * The only bridge between renderer and main. Nothing else is exposed:
 * no node integration, no remote module, no raw ipcRenderer.
 */
const bridge = {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args)
  },

  on(channel: IpcEventChannel, listener: (payload: unknown) => void): () => void {
    if (!IPC_EVENT_CHANNELS.includes(channel)) {
      throw new Error(`Unknown event channel: ${channel}`)
    }
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown): void =>
      listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },

  platform: process.platform
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('harness', bridge)
} else {
  // Only reachable if contextIsolation is disabled, which it is not.
  // @ts-expect-error -- fallback path for a non-isolated context
  window.harness = bridge
}
