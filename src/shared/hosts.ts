/**
 * Where a piece of work actually ran, said in words.
 *
 * The edit card used to claim every stage happened "on the Mac Studio". That is
 * only true of the chat endpoint, and only while it is pointed there — the
 * renderer is ComfyUI at COMFY_HOST, which is loopback by default and therefore
 * this MacBook. A progress line that names the wrong machine is worse than one
 * that names none, so the label is derived from the URL the stage really used.
 */

/** Hostnames that mean "the machine LocalHarness is running on". */
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost', '0.0.0.0'])

/** Human label for the machine behind a URL: 'this Mac', or its short hostname. */
export function hostLabel(url: string | undefined | null): string | null {
  if (typeof url !== 'string' || url.trim() === '') return null
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return null
  }
  if (host === '') return null
  if (LOOPBACK.has(host.toLowerCase())) return 'this Mac'
  // Trim the domain — a tailnet FQDN reads as noise mid-sentence.
  const short = host.split('.')[0]
  return short === '' ? host : short
}
