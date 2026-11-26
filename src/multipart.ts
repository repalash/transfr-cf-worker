import type { Config } from "./config"
import { errorResponse, jsonResponse } from "./http"
import { decodeFilename, isPendingUpload, PENDING_UPLOAD_METADATA, reserveNewKey } from "./keys"
import { contentTypeFor } from "./mime"
import { emptyBody, isLengthMismatch, parseContentLength, storedReply, validateFilename } from "./upload"

/**
 * Uploads larger than one request may carry (Cloudflare caps a request body
 * at 100 MB) go up in parts and are joined into one file, with one link:
 *
 *   POST /<name>?uploads&size=<bytes>            -> {key, upload_id, part_size, part_count}
 *   PUT  /<key>?upload_id=<id>&part=<n>  <bytes> -> {part, etag}
 *   POST /<key>?upload_id=<id>&complete  {"parts":[{"part":1,"etag":"..."}, ...]}
 *                                                -> the same reply as a plain upload
 *
 * Every part but the last is exactly part_size bytes. The key is chosen by the
 * worker when the upload starts, so a part can never land on an existing file.
 */
export function isMultipartRequest(url: URL): boolean {
  return url.searchParams.has("uploads") || url.searchParams.has("upload_id")
}

export async function handleMultipart(request: Request, url: URL, config: Config): Promise<Response> {
  const path = url.pathname.replace(/^\/+/, "")
  if (url.searchParams.has("uploads")) {
    if (request.method !== "POST") return usage(url, "Start a large upload with POST")
    return await start(request, url, path, config)
  }

  const uploadId = url.searchParams.get("upload_id") ?? ""
  if (!uploadId || !KEY_RE.test(path)) return usage(url, "This is not a large upload's address")
  if (request.method === "PUT" && url.searchParams.has("part")) {
    return await uploadPart(request, url, path, uploadId, config)
  }
  if (request.method === "POST" && url.searchParams.has("complete")) {
    return await complete(request, url, path, uploadId, config)
  }
  return usage(url, "Send each part with PUT ...&part=<n>, then POST ...&complete")
}

/** The key layout the worker creates: `<expiry hex>-<random hex>/<name>`. */
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{1,2}\/./

async function start(request: Request, url: URL, path: string, config: Config): Promise<Response> {
  const invalid = validateFilename(path, url)
  if (invalid) return invalid
  const size = Number(url.searchParams.get("size") ?? "")
  if (!Number.isSafeInteger(size) || size < 1) {
    return errorResponse("invalid_size", "Say how large the file is: ?uploads&size=<bytes>", 400)
  }
  if (size > config.maxMultipartFileSizeBytes) {
    return errorResponse(
      "too_large",
      `Invalid file size: ${size}, max size = ${config.maxMultipartFileSizeBytes}`,
      413,
    )
  }

  // An empty placeholder holds the key while the parts arrive, so no other
  // upload can be given the same link in the meantime.
  const contentType = contentTypeFor(request.headers.get("content-type"), decodeFilename(path))
  const { key, expiresAt } = await reserveNewKey(config.bucket, path, config.fileTtlSeconds, {
    contentType,
    customMetadata: { [PENDING_UPLOAD_METADATA]: "1" },
  })
  const upload = await config.bucket.createMultipartUpload(key, {
    httpMetadata: { contentType },
    customMetadata: { expiresAt: String(expiresAt) },
  })
  const partSize = config.multipartPartSizeBytes
  return jsonResponse({
    key,
    upload_id: upload.uploadId,
    part_size: partSize,
    part_count: Math.ceil(size / partSize),
    upload_url: `${url.origin}/${key}?upload_id=${encodeURIComponent(upload.uploadId)}`,
  })
}

async function uploadPart(
  request: Request,
  url: URL,
  key: string,
  uploadId: string,
  config: Config,
): Promise<Response> {
  const partSize = config.multipartPartSizeBytes
  const maxParts = Math.ceil(config.maxMultipartFileSizeBytes / partSize)
  const part = Number(url.searchParams.get("part"))
  if (!Number.isSafeInteger(part) || part < 1 || part > maxParts) {
    return errorResponse("invalid_part", `The part number must be from 1 to ${maxParts}`, 400)
  }
  if (!request.body) return emptyBody(url)
  const declared = parseContentLength(request.headers.get("content-length"))
  if (declared === null) {
    return errorResponse("length_required", "Send each part with a Content-Length header", 411)
  }
  if (declared < 1) return emptyBody(url)
  // The last part the limit allows only gets what is left of the limit, so
  // the joined file can never pass it, whatever the part size.
  const allowed = Math.min(partSize, config.maxMultipartFileSizeBytes - (part - 1) * partSize)
  if (declared > allowed) {
    return errorResponse("too_large", `Invalid part size: ${declared}, part ${part} is at most ${allowed}`, 413)
  }

  const upload = config.bucket.resumeMultipartUpload(key, uploadId)
  const { readable, writable } = new FixedLengthStream(declared)
  request.body.pipeTo(writable).catch(() => {})
  try {
    const uploaded = await upload.uploadPart(part, readable)
    return jsonResponse({ part: uploaded.partNumber, etag: uploaded.etag })
  } catch (error) {
    if (isUnknownUpload(error)) return unknownUpload()
    if (isLengthMismatch(error)) {
      return errorResponse(
        "length_mismatch",
        `Part incomplete: the body did not match its Content-Length of ${declared}`,
        400,
      )
    }
    console.error("part upload failed", { part, error })
    throw error
  }
}

async function complete(
  request: Request,
  url: URL,
  key: string,
  uploadId: string,
  config: Config,
): Promise<Response> {
  let parts: R2UploadedPart[]
  try {
    const body = (await request.json()) as { parts?: { part?: unknown; etag?: unknown }[] }
    parts = (body.parts ?? []).map(({ part, etag }) => {
      if (typeof part !== "number" || typeof etag !== "string") throw new Error("bad part")
      return { partNumber: part, etag }
    })
    if (parts.length < 1) throw new Error("no parts")
  } catch {
    return errorResponse(
      "invalid_parts",
      'Send the parts as JSON: {"parts":[{"part":1,"etag":"..."}, ...]}, using each part\'s reply',
      400,
    )
  }

  // Only this upload's own placeholder may be replaced. Anything else at the
  // key (which should never happen) is a file that must not be overwritten.
  const holder = await config.bucket.head(key)
  if (holder !== null && !isPendingUpload(holder)) {
    return errorResponse(
      "upload_conflict",
      "Another file was stored at this address while the upload ran. Start the upload again",
      409,
    )
  }

  let object: R2Object
  try {
    object = await config.bucket.resumeMultipartUpload(key, uploadId).complete(parts)
  } catch (error) {
    if (isUnknownUpload(error)) return unknownUpload()
    if (isInvalidParts(error)) {
      return errorResponse(
        "invalid_parts",
        "The parts could not be joined: send every part's number and etag, all but the last part_size bytes long",
        400,
      )
    }
    console.error("joining parts failed", { key, error })
    throw error
  }
  const expiresAt = Number(object.customMetadata?.expiresAt) || Math.floor(Date.now() / 1000) + config.fileTtlSeconds
  return storedReply(request, url, key, expiresAt, object, object.httpMetadata?.contentType, config)
}

/**
 * R2's refusals that are the client's doing: a part it does not have or with
 * a wrong etag (10025), or parts but the last smaller than 5 MB (10011).
 */
function isInvalidParts(error: unknown): boolean {
  return error instanceof Error && /\((10025|10011)\)|InvalidPart|EntityTooSmall/.test(error.message)
}

function isUnknownUpload(error: unknown): boolean {
  return error instanceof Error && /NoSuchUpload|upload.*(not found|does not exist)|10024/i.test(error.message)
}

function unknownUpload(): Response {
  return errorResponse("unknown_upload", "No such upload: it was finished already, or the address is wrong", 404)
}

function usage(url: URL, message: string): Response {
  return errorResponse("invalid_upload", `${message}. Usage: ${url.origin}/llms.txt`, 400)
}
