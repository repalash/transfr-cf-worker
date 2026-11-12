import { type Config, MAX_FILENAME_LENGTH } from "./config"
import { textResponse } from "./http"
import { createObjectKey, decodeFilename } from "./keys"
import { sanitizeContentType } from "./mime"

export async function handleUpload(request: Request, url: URL, config: Config): Promise<Response> {
  const filename = url.pathname.replace(/^\/+/, "")

  if (filename.length < 1) {
    return textResponse(`No filename, pass a filename into the url, like: ${url.origin}/filename.txt \n`, 400)
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return textResponse(`Filename too long, max ${MAX_FILENAME_LENGTH} characters\n`, 400)
  }
  if (!isSafeFilename(filename)) {
    return textResponse("Invalid filename\n", 400)
  }

  if (!request.body) return emptyBody()

  const declared = parseContentLength(request.headers.get("content-length"))
  if (declared === 0) return emptyBody()
  if (declared !== null && declared > config.maxFileSizeBytes) {
    return textResponse(`Invalid file size: ${declared}, max size = ${config.maxFileSizeBytes}\n`, 413)
  }

  // R2 needs to know an object's length up front. With a Content-Length the
  // body streams straight into R2, so the size limit is not bounded by the
  // Worker's memory; without one (a chunked upload, e.g. `curl -T -`) the body
  // has to be read into memory first, under a lower limit.
  let body: ReadableStream | Uint8Array
  let bodyError: unknown = null
  if (declared !== null) {
    // FixedLengthStream gives R2 the length, and errors (failing the put) if
    // the body turns out shorter or longer than declared.
    const { readable, writable } = new FixedLengthStream(declared)
    request.body.pipeTo(writable).catch((error: unknown) => {
      bodyError = error
    })
    body = readable
  } else {
    const buffered = await readAtMost(request.body, config.maxBufferedFileSizeBytes)
    if (buffered === null) {
      return textResponse(
        `Invalid file size: more than ${config.maxBufferedFileSizeBytes}, ` +
          `max size without a Content-Length header = ${config.maxBufferedFileSizeBytes}. ` +
          `Send a Content-Length header (curl --upload-file and --data-binary @file do) ` +
          `to upload up to ${config.maxFileSizeBytes}\n`,
        413,
      )
    }
    if (buffered.byteLength < 1) return emptyBody()
    body = buffered
  }

  const { key, expiresAt } = createObjectKey(filename, config.fileTtlSeconds)

  // Awaited rather than deferred with waitUntil: the URL is returned to the
  // client, so the object has to be readable by the time it is.
  try {
    await config.bucket.put(key, body, {
      httpMetadata: { contentType: sanitizeContentType(request.headers.get("content-type")) },
      customMetadata: { expiresAt: String(expiresAt) },
    })
  } catch (error) {
    // A body that broke off or did not match its Content-Length is the
    // client's problem; anything else is ours.
    if (declared !== null && (bodyError !== null || isLengthMismatch(error))) {
      return textResponse(`Upload incomplete: the body did not match its Content-Length of ${declared}\n`, 400)
    }
    throw error
  }

  return textResponse(`${url.origin}/${key}\n`)
}

function emptyBody(): Response {
  return textResponse("Empty body, there is nothing to upload\n", 400)
}

/** A Content-Length header as a byte count, or null when absent or malformed. */
function parseContentLength(header: string | null): number | null {
  if (header === null || !/^\d+$/.test(header.trim())) return null
  const length = Number(header.trim())
  return Number.isSafeInteger(length) ? length : null
}

/** Reads the whole stream, or gives up and returns null once it exceeds `limit` bytes. */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** The put fails with this when the body is shorter or longer than its Content-Length. */
function isLengthMismatch(error: unknown): boolean {
  return error instanceof TypeError && error.message.includes("FixedLengthStream")
}

/**
 * The path becomes both the object key and part of a URL, so control
 * characters and empty or dot path segments are rejected.
 */
function isSafeFilename(filename: string): boolean {
  const decoded = decodeFilename(filename)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(filename)) return false
  return !decoded.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
}
