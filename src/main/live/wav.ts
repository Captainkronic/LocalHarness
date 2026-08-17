/**
 * WAV framing for the live voice pipeline. No dependency — this is 44 bytes of
 * header and a copy.
 *
 * It exists because both ends of the pipeline are file-based. voice-mcp's
 * `transcribe` takes a PATH, so the renderer's PCM has to become a real file on
 * disk; `speak` writes a file, so the bytes have to become a data: URL before
 * the renderer (which cannot read the filesystem) can play them.
 *
 * Get the header wrong and whisper does not complain — it returns silence, or a
 * transcript of noise, which is a miserable thing to debug from the other end of
 * an MCP call. So: little-endian everywhere, chunk sizes measured from the field
 * that follows them, and a fixed mono 16-bit layout that matches what the
 * renderer's AudioWorklet produces.
 */

/** Canonical PCM header: RIFF + fmt (16 bytes of body) + data. */
const HEADER_BYTES = 44
const BITS_PER_SAMPLE = 16
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8
const CHANNELS = 1
/** WAVE_FORMAT_PCM. Anything else needs a longer fmt chunk. */
const FORMAT_PCM = 1
/** The two size fields are uint32, so this is a hard limit of the format. */
const MAX_DATA_BYTES = 0xffff_ffff - HEADER_BYTES

/**
 * Mono 16-bit WAV from raw PCM samples.
 *
 * Samples are written one at a time rather than copied from the typed array's
 * backing buffer: `Int16Array` is host-endian, and the file must be
 * little-endian whatever the host is.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const rate = Math.round(sampleRate)
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new RangeError(`sampleRate must be a positive number, got ${String(sampleRate)}`)
  }

  const dataBytes = pcm.length * BYTES_PER_SAMPLE
  if (dataBytes > MAX_DATA_BYTES) {
    throw new RangeError(`${dataBytes} bytes of audio exceeds what a WAV header can describe`)
  }

  // Zero-filled rather than allocUnsafe: a miscounted header offset would
  // otherwise leak uninitialised memory into a file we hand to another process.
  const out = Buffer.alloc(HEADER_BYTES + dataBytes)

  out.write('RIFF', 0, 'ascii')
  // Size of everything AFTER this field — i.e. the file length minus 8.
  out.writeUInt32LE(HEADER_BYTES - 8 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')

  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16) // fmt body length for PCM
  out.writeUInt16LE(FORMAT_PCM, 20)
  out.writeUInt16LE(CHANNELS, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * CHANNELS * BYTES_PER_SAMPLE, 28) // byte rate
  out.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32) // block align
  out.writeUInt16LE(BITS_PER_SAMPLE, 34)

  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < pcm.length; i++) {
    out.writeInt16LE(pcm[i], HEADER_BYTES + i * BYTES_PER_SAMPLE)
  }

  return out
}

/**
 * Audio file bytes as a data: URL the renderer can hand straight to an
 * `Audio` element. Named for its caller's job — it takes whatever voice-mcp
 * wrote, which is wav here but need not be.
 */
export function decodeWavToDataUrl(buf: Buffer, mime: string): string {
  if (buf.length === 0) {
    throw new Error('cannot build a data URL from an empty audio buffer')
  }
  const type = typeof mime === 'string' && mime.trim().length > 0 ? mime.trim() : 'audio/wav'
  return `data:${type};base64,${buf.toString('base64')}`
}
