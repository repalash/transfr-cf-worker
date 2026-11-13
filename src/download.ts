import type { Config } from "./config"
import { corsHeaders } from "./cors"
import { htmlResponse, isNavigation, NO_INDEX, notFound, textResponse } from "./http"
import { decodeFilename, filenameFromKey, isExpired, parseExpiry } from "./keys"
import { contentDisposition } from "./mime"
import { formatDuration } from "./format"
import { renderAccessPage } from "./pages"
import { siteResponse } from "./site"

const EXPOSED_HEADERS = "Content-Length, Content-Range, Content-Type, Content-Disposition, ETag, Last-Modified"
const MAX_BROWSER_CACHE_SECONDS = 86_400
/** The same link answers with the file page or the bytes depending on these. */
const VARY_ON_REQUEST_TYPE = "Sec-Fetch-Dest, Accept"
/**
 * Uploads are untrusted content served from this origin. `sandbox` and
 * `default-src 'none'` stop anything in them from running or loading; the
 * exceptions are what the browser's own image, audio and video viewers need to
 * show the file itself.
 */
const FILE_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self' data:; style-src 'unsafe-inline'; sandbox"

export async function handleDownload(
  request: Request,
  url: URL,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response> {
  const key = url.pathname.replace(/^\/+/, "")
  const isHead = request.method === "HEAD"

  // The landing page, the text guide, robots.txt and the sitemap.
  const site = siteResponse(request, url, config, key)
  if (site) return site

  // The expiry is part of the key, so the file stops being served on time even
  // if the R2 lifecycle rule (day granularity) has not removed it yet.
  if (isExpired(key)) {
    ctx.waitUntil(config.bucket.delete(key).catch((error) => console.error("expired object delete failed", error)))
    return notFound(formatDuration(config.fileTtlSeconds))
  }

  if (!isHead && !url.searchParams.has("raw") && prefersAccessPage(request, url, config)) {
    return await accessPageResponse(key, url, config)
  }

  if (isHead) {
    const object = await config.bucket.head(key)
    if (!object) return notFound(formatDuration(config.fileTtlSeconds))
    return new Response(null, { status: 200, headers: objectHeaders(object, key) })
  }

  // A Range header that is not a single byte range is ignored, as HTTP allows.
  const requestedRange = parseRange(request.headers.get("range"))

  let object: R2Object | R2ObjectBody | null
  try {
    // R2 evaluates the conditional headers (If-None-Match and friends) itself.
    object = await config.bucket.get(key, { range: requestedRange ?? undefined, onlyIf: request.headers })
  } catch (error) {
    // R2 throws for a range that starts past the end of the object. Anything
    // else is a real failure and must not be reported as the client's.
    const unsatisfiable = requestedRange ? await rangeNotSatisfiable(key, requestedRange, config) : null
    if (unsatisfiable) return unsatisfiable
    throw error
  }
  if (!object) return notFound(formatDuration(config.fileTtlSeconds))

  const headers = objectHeaders(object, key)
  const body = "body" in object ? object.body : null
  if (!body) {
    // R2 returned metadata only: a conditional request that was not satisfied.
    headers.delete("Content-Length")
    const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since")
    return new Response(null, { status: notModified ? 304 : 412, headers })
  }

  const range = requestedRange ? resolveRange(object.range ?? requestedRange, object.size) : null
  if (range && range.length < 1) {
    await body.cancel()
    return textResponse("Range Not Satisfiable\n", 416, { "Content-Range": `bytes */${object.size}` })
  }
  if (range) {
    headers.set("Content-Length", String(range.length))
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`)
    return new Response(body, { status: 206, headers })
  }

  return new Response(body, { status: 200, headers })
}

/**
 * Only a browser navigating to the link gets the file page. Everything else
 * gets the bytes: curl and scripts, and also `fetch()`, `<img>` and `<video>`
 * in a browser, which is why the User-Agent is not what decides.
 */
function prefersAccessPage(request: Request, url: URL, config: Config): boolean {
  if (config.rawOnlyHosts.includes(url.hostname.toLowerCase())) return false
  return isNavigation(request)
}

async function accessPageResponse(key: string, url: URL, config: Config): Promise<Response> {
  const object = await config.bucket.head(key)
  if (!object) return notFound(formatDuration(config.fileTtlSeconds))

  const filename = decodeFilename(filenameFromKey(key))
  const contentType = object.httpMetadata?.contentType ?? ""
  const encrypted =
    /\.(pgp|gpg|asc)$/i.test(filename) || url.searchParams.has("enc") || contentType.includes("pgp-encrypted")
  const fileUrl = `${url.origin}${url.pathname}`

  return htmlResponse(
    renderAccessPage({
      filename,
      size: object.size,
      encrypted,
      fileUrl,
      rawUrl: `${fileUrl}?raw=1`,
      homeUrl: `${url.origin}/`,
      siteOrigin: config.canonicalOrigin ?? url.origin,
      expiresAt: parseExpiry(key),
      ttlSeconds: config.fileTtlSeconds,
    }),
    { extraHeaders: { "X-Robots-Tag": NO_INDEX, Vary: VARY_ON_REQUEST_TYPE } },
  )
}

function objectHeaders(object: R2Object, key: string): Headers {
  const filename = decodeFilename(filenameFromKey(key))
  const contentType = object.httpMetadata?.contentType || "application/octet-stream"

  const headers = new Headers({
    ...corsHeaders,
    "Content-Type": contentType,
    "Content-Length": String(object.size),
    // Uploads are untrusted content served from this origin, so the browser is
    // told to download instead of render anything scriptable, and never to
    // sniff a type of its own.
    "Content-Disposition": contentDisposition(filename, contentType),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": FILE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": NO_INDEX,
    Vary: VARY_ON_REQUEST_TYPE,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl(key),
    "Last-Modified": object.uploaded.toUTCString(),
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
  })
  if (object.httpEtag) headers.set("ETag", object.httpEtag)
  return headers
}

/** Objects never change, so they may be cached for as long as they exist. */
function cacheControl(key: string): string {
  const expiresAt = parseExpiry(key)
  if (expiresAt === null) return "private, max-age=3600"
  const remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1000))
  return `private, max-age=${Math.min(remaining, MAX_BROWSER_CACHE_SECONDS)}, immutable`
}

function resolveRange(range: R2Range | undefined, size: number): { offset: number; length: number } | null {
  if (!range) return null
  if ("suffix" in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size)
    return { offset: size - length, length }
  }
  const offset = "offset" in range && range.offset !== undefined ? range.offset : 0
  const available = Math.max(0, size - offset)
  const length = "length" in range && range.length !== undefined ? Math.min(range.length, available) : available
  return { offset, length }
}

/** A single `bytes=` range as R2 takes it, or null for anything else. */
function parseRange(header: string | null): R2Range | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "")
  if (!match) return null
  const [, first, last] = match
  if (first === "") return last === "" ? null : { suffix: Number(last) }
  const offset = Number(first)
  if (last === "") return { offset }
  const end = Number(last)
  return end < offset ? null : { offset, length: end - offset + 1 }
}

/** A 416 if `range` lies outside the object, a 404 if there is no object, else null. */
async function rangeNotSatisfiable(key: string, range: R2Range, config: Config): Promise<Response | null> {
  const object = await config.bucket.head(key)
  if (!object) return notFound(formatDuration(config.fileTtlSeconds))
  const outside = "suffix" in range ? range.suffix === 0 : (range.offset ?? 0) >= object.size
  if (!outside) return null
  return textResponse("Range Not Satisfiable\n", 416, { "Content-Range": `bytes */${object.size}` })
}
