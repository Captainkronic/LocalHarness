/**
 * A local HTTP origin for a workspace folder.
 *
 * This exists because of a wall the model cannot code its way around: ES
 * modules are forbidden over `file://`. A page that says
 * `import * as THREE from './three.min.js'` fails on origin grounds before a
 * single line of the app runs, and nothing in the source is wrong. Watching a
 * run hit this, the model had to derive the rule from first principles and then
 * hand-roll `python3 -m http.server` — several minutes and a fistful of shell
 * calls to arrive at a fact that never changes.
 *
 * Two details here are the whole point, and both are lessons from that run:
 *
 * `.js` MUST be served as `text/javascript`. A wrong MIME type is worse than a
 * missing file, because the browser reports it as a module error rather than a
 * server error and the model goes looking in its own code.
 *
 * NOTHING is cacheable. The model's loop is edit -> reload -> look. A cached
 * response means it reads its previous attempt, concludes the edit did nothing,
 * and starts undoing correct work. `no-store` costs nothing on localhost and
 * removes an entire category of false conclusion.
 */

import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import nodePath from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Extension -> Content-Type.
 *
 * Deliberately short: this serves a workspace a model is building in, not the
 * open web. Anything unlisted is sent as octet-stream, which browsers refuse to
 * execute — the safe direction to be wrong in.
 */
const TYPES = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.htm', 'text/html; charset=utf-8'],
  /* text/javascript, not application/javascript: the former is what the HTML
     spec calls the module MIME type, and Safari has historically been strict. */
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json']
])

export function contentTypeFor(filePath: string): string {
  return TYPES.get(nodePath.extname(filePath).toLowerCase()) ?? 'application/octet-stream'
}

/**
 * Map a request URL onto a file inside `root`, or null if it escapes.
 *
 * Exported for testing, because the escape check is the one piece here where
 * being wrong is a security bug rather than a broken page.
 */
export function resolveRequestPath(root: string, rawUrl: string): string | null {
  let pathname: string
  try {
    /* A dummy base: only the path matters, and this drops the query string,
       which is how the model's own cache-busting `?fresh=1` survives. */
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    return null
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null // malformed percent-encoding
  }

  /* A NUL byte truncates the path inside some syscalls; refuse rather than
     reason about it. */
  if (decoded.includes('\0')) return null

  const target = nodePath.resolve(root, `.${nodePath.sep}${decoded.replace(/^\/+/, '')}`)

  /* The containment check must compare against root + separator, or a sibling
     directory whose name merely starts with the root's name would pass. */
  const prefix = root.endsWith(nodePath.sep) ? root : root + nodePath.sep
  if (target !== root && !target.startsWith(prefix)) return null
  return target
}

export interface ServedDir {
  /** The absolute directory being served. */
  root: string
  /** Origin with no trailing slash, e.g. http://127.0.0.1:52341 */
  origin: string
  port: number
  startedAt: number
}

interface Entry extends ServedDir {
  server: Server
}

/**
 * The set of folders currently served, keyed by absolute path.
 *
 * Module-level rather than per-executor: a second `serve_dir` on the same
 * folder must hand back the same origin, not leak another listener. The model
 * has no reason to track which folders it already served, and a run that opens
 * one page a dozen times should not end up with a dozen ports.
 */
const SERVED = new Map<string, Entry>()

/**
 * The port this folder should get, derived from its path.
 *
 * `listen(0)` hands out whatever is free, which is fine until the app restarts:
 * the folder gets served again on a DIFFERENT port, and every URL the model is
 * carrying in its context — the one it just wrote into a test, the one in the
 * page it is iterating on — points at nothing. Observed exactly that way after
 * a rebuild: a run kept loading a dead `:65095` and read the empty result as a
 * broken page rather than a moved server.
 *
 * Hashing the path instead means the same folder comes back on the same origin
 * across restarts, so those URLs keep working. The range is the IANA dynamic
 * range, which is where an ephemeral port would have come from anyway.
 *
 * Collisions are handled by falling back to 0 rather than by being clever: two
 * folders hashing together is rare, and one of them getting an arbitrary port
 * is exactly the behaviour we had before.
 */
function preferredPort(root: string): number {
  const digest = createHash('sha256').update(root).digest()
  return 49152 + (digest.readUInt16BE(0) % 16000)
}

export async function serveDirectory(root: string): Promise<ServedDir> {
  const existing = SERVED.get(root)
  if (existing) return publicView(existing)

  const server = createServer((req, res) => {
    void handle(root, req.url ?? '/', res)
  })

  /* Loopback only. This is a build aid, not a way to publish the workspace to
     whatever network the laptop is on. */
  await new Promise<void>((resolve, reject) => {
    let triedPreferred = false
    const onError = (err: Error): void => {
      /* Something else already holds the derived port — another app, or a
         previous instance of this one that has not let go yet. Fall back to an
         ephemeral port rather than refusing to serve at all. */
      if (!triedPreferred) return reject(err)
      triedPreferred = false
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', onError)
        resolve()
      })
    }
    server.on('error', onError)
    triedPreferred = true
    server.listen(preferredPort(root), '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('The server started but reported no port.')
  }

  /* Long-lived pages hold keep-alive sockets open; without this, close() waits
     on them and quitting the app stalls. */
  server.keepAliveTimeout = 5_000

  const entry: Entry = {
    root,
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    startedAt: Date.now(),
    server
  }
  SERVED.set(root, entry)
  return publicView(entry)
}

function publicView(e: Entry): ServedDir {
  return { root: e.root, origin: e.origin, port: e.port, startedAt: e.startedAt }
}

export function listServed(): ServedDir[] {
  return [...SERVED.values()].map(publicView)
}

/** Stop every server. Called on app shutdown so no listener outlives the app. */
export function stopAllServed(): void {
  for (const entry of SERVED.values()) {
    entry.server.closeAllConnections?.()
    entry.server.close()
  }
  SERVED.clear()
}

async function handle(
  root: string,
  rawUrl: string,
  res: import('node:http').ServerResponse
): Promise<void> {
  const send = (code: number, body: string): void => {
    res.writeHead(code, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(body)
  }

  const target = resolveRequestPath(root, rawUrl)
  if (target === null) {
    send(403, 'Forbidden: that path is outside the served directory.')
    return
  }

  let filePath = target
  try {
    const info = await stat(filePath)
    if (info.isDirectory()) {
      filePath = nodePath.join(filePath, 'index.html')
      const index = await stat(filePath).catch(() => null)
      if (!index?.isFile()) {
        send(404, 'No index.html in that directory.')
        return
      }
    } else if (!info.isFile()) {
      send(404, 'Not a file.')
      return
    }
  } catch {
    send(404, `Not found: ${nodePath.relative(root, target) || '/'}`)
    return
  }

  res.writeHead(200, {
    'content-type': contentTypeFor(filePath),
    /* The reason this server exists is that the model reloads after every
       edit. A cached response would show it its own previous attempt. */
    'cache-control': 'no-store, must-revalidate',
    /* SharedArrayBuffer and precise timers stay available for anything that
       wants threads; harmless otherwise. */
    'cross-origin-resource-policy': 'same-origin'
  })

  const stream = createReadStream(filePath)
  stream.on('error', () => {
    res.destroy()
  })
  stream.pipe(res)
}

/** For error messages that want to name the file the way a person would. */
export function fileUrl(p: string): string {
  return pathToFileURL(p).href
}
