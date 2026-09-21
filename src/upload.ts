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

  // Reject oversized uploads before buffering them.
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > config.maxFileSizeBytes) {
    return tooLarge(declared, config)
  }

  const body = await request.arrayBuffer()
  const size = body.byteLength
  if (size < 1) return textResponse("Empty body, there is nothing to upload\n", 400)
  if (size > config.maxFileSizeBytes) return tooLarge(size, config)

  const { key, expiresAt } = createObjectKey(filename, config.fileTtlSeconds)

  // Awaited rather than deferred with waitUntil: the URL is returned to the
  // client, so the object has to be readable by the time it is.
  await config.bucket.put(key, body, {
    httpMetadata: { contentType: sanitizeContentType(request.headers.get("content-type")) },
    customMetadata: { expiresAt: String(expiresAt) },
  })

  return textResponse(`${url.origin}/${key}\n`)
}

function tooLarge(size: number, config: Config): Response {
  return textResponse(`Invalid file size: ${size}, max size = ${config.maxFileSizeBytes}\n`, 413)
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
