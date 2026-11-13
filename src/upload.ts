import { type Config, MAX_ENCODED_FILENAME_LENGTH, MAX_FILENAME_LENGTH } from "./config"
import { errorResponse, jsonResponse, textResponse, wantsJson } from "./http"
import { createObjectKey, decodeFilename } from "./keys"
import { contentTypeFor } from "./mime"

/** A multipart form adds boundaries and part headers around the file. */
const FORM_OVERHEAD_BYTES = 64 * 1024

export async function handleUpload(request: Request, url: URL, config: Config): Promise<Response> {
  const pathName = url.pathname.replace(/^\/+/, "")
  const contentType = request.headers.get("content-type")
  const isForm = /^multipart\/form-data\b/i.test(contentType ?? "")

  // A form upload may leave the name to the file inside the form.
  if (!(isForm && pathName === "")) {
    const invalid = validateFilename(pathName, url)
    if (invalid) return invalid
  }
  if (!request.body) return emptyBody(url)
  if (isForm) return await handleFormUpload(request, request.body, url, pathName, config)

  const declared = parseContentLength(request.headers.get("content-length"))
  if (declared === 0) return emptyBody(url)
  if (declared !== null && declared > config.maxFileSizeBytes) {
    return errorResponse("too_large", `Invalid file size: ${declared}, max size = ${config.maxFileSizeBytes}`, 413)
  }

  // R2 needs to know an object's length up front. With a Content-Length the
  // body streams straight into R2, so the size limit is not bounded by the
  // Worker's memory; without one (a chunked upload, e.g. `curl -T -`) the body
  // has to be read into memory first, under a lower limit.
  if (declared === null) {
    const buffered = await readAtMost(request.body, config.maxBufferedFileSizeBytes)
    if (buffered === null) {
      return errorResponse(
        "too_large",
        `Invalid file size: more than ${config.maxBufferedFileSizeBytes}, ` +
          `max size without a Content-Length header = ${config.maxBufferedFileSizeBytes}. ` +
          `Send a Content-Length header (curl --upload-file and --data-binary @file do) ` +
          `to upload up to ${config.maxFileSizeBytes}`,
        413,
      )
    }
    if (buffered.byteLength < 1) return emptyBody(url)
    return await store(request, pathName, buffered, contentType, url, config)
  }

  // FixedLengthStream gives R2 the length, and errors (failing the put) if the
  // body turns out shorter or longer than declared.
  const { readable, writable } = new FixedLengthStream(declared)
  let bodyError: unknown = null
  request.body.pipeTo(writable).catch((error: unknown) => {
    bodyError = error
  })
  try {
    return await store(request, pathName, readable, contentType, url, config)
  } catch (error) {
    if (isLengthMismatch(error)) {
      return errorResponse(
        "length_mismatch",
        `Upload incomplete: the body did not match its Content-Length of ${declared}`,
        400,
      )
    }
    // Either the client went away or R2 failed, and the two cannot be told
    // apart reliably here. Say what is known and let it surface as a 500, so a
    // storage problem is never written off as the client's.
    console.error("streamed upload failed", { declared, bodyError })
    throw error
  }
}

/**
 * `curl -F file=@name` and HTML forms wrap the file in a multipart body. The
 * file is taken out of it, so what gets stored is the file and not the form.
 * Parsing needs the whole body in memory, hence the buffered size limit.
 */
async function handleFormUpload(
  request: Request,
  body: ReadableStream<Uint8Array>,
  url: URL,
  pathName: string,
  config: Config,
): Promise<Response> {
  const limit = config.maxBufferedFileSizeBytes
  const tooLarge = () =>
    errorResponse(
      "too_large",
      `Invalid file size: form uploads (curl -F) are limited to ${limit}. ` +
        `Upload the file itself (curl --upload-file) for up to ${config.maxFileSizeBytes}`,
      413,
    )

  const declared = parseContentLength(request.headers.get("content-length"))
  if (declared !== null && declared > limit + FORM_OVERHEAD_BYTES) return tooLarge()
  const raw = await readAtMost(body, limit + FORM_OVERHEAD_BYTES)
  if (raw === null) return tooLarge()

  let file: File | undefined
  try {
    const form = await new Response(raw, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData()
    for (const value of form.values()) {
      if (typeof value !== "string") {
        file = value
        break
      }
    }
  } catch {
    return errorResponse(
      "invalid_form",
      `Could not read the form. Send the file as the request body instead: PUT ${url.origin}/<file name>`,
      400,
    )
  }
  if (!file) {
    return errorResponse(
      "no_file_in_form",
      `No file in the form. Add a file field (curl -F file=@name), or send the file as the request body: PUT ${url.origin}/<file name>`,
      400,
    )
  }
  if (file.size < 1) return emptyBody(url)
  if (file.size > limit) return tooLarge()

  const filename = pathName || encodeURIComponent(file.name)
  const invalid = validateFilename(filename, url)
  if (invalid) return invalid
  return await store(request, filename, new Uint8Array(await file.arrayBuffer()), file.type, url, config)
}

/** Null if the name can be stored, otherwise the response explaining why not. */
function validateFilename(filename: string, url: URL): Response | null {
  if (filename.length < 1) {
    return errorResponse("no_filename", `No filename: put one in the URL, like ${url.origin}/filename.txt`, 400)
  }
  // Counted decoded, so a name in a non-Latin script gets as many characters
  // as an ASCII one; the encoded form has its own, storage driven, limit.
  if (decodeFilename(filename).length > MAX_FILENAME_LENGTH || filename.length > MAX_ENCODED_FILENAME_LENGTH) {
    return errorResponse("filename_too_long", `Filename too long, max ${MAX_FILENAME_LENGTH} characters`, 400)
  }
  if (!isSafeFilename(filename)) {
    return errorResponse(
      "invalid_filename",
      "Invalid filename: it cannot contain control characters, or empty, '.' or '..' path segments",
      400,
    )
  }
  return null
}

async function store(
  request: Request,
  filename: string,
  body: ReadableStream | Uint8Array,
  sentContentType: string | null,
  url: URL,
  config: Config,
): Promise<Response> {
  const { key, expiresAt } = createObjectKey(filename, config.fileTtlSeconds)
  const name = decodeFilename(filename)
  const contentType = contentTypeFor(sentContentType, name)

  // Awaited rather than deferred with waitUntil: the URL is returned to the
  // client, so the object has to be readable by the time it is.
  const object = await config.bucket.put(key, body, {
    httpMetadata: { contentType },
    customMetadata: { expiresAt: String(expiresAt) },
  })

  const link = `${url.origin}/${key}`
  const expires = new Date(expiresAt * 1000).toISOString()
  if (wantsJson(request)) {
    return jsonResponse({
      url: link,
      raw_url: `${link}?raw=1`,
      name,
      size: object.size,
      content_type: contentType ?? "application/octet-stream",
      md5: object.checksums.md5 ? hex(object.checksums.md5) : undefined,
      expires_at: expires,
      expires_in_seconds: config.fileTtlSeconds,
    })
  }
  return textResponse(`${link}\n`, 200, { "X-Expires-At": expires, "Access-Control-Expose-Headers": "X-Expires-At" })
}

function emptyBody(url: URL): Response {
  return errorResponse(
    "empty_body",
    `Empty body, there is nothing to upload. Send the file's bytes as the request body: PUT ${url.origin}/<file name>`,
    400,
  )
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
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
