import type { Config } from "./config"
import { corsHeaders } from "./cors"
import { htmlResponse, notFound, textResponse } from "./http"
import { decodeFilename, filenameFromKey, isExpired, parseExpiry } from "./keys"
import { contentDisposition } from "./mime"
import { renderAccessPage, renderIndexPage } from "./pages"

const EXPOSED_HEADERS = "Content-Length, Content-Range, Content-Type, Content-Disposition, ETag, Last-Modified"
const MAX_BROWSER_CACHE_SECONDS = 86_400

export async function handleDownload(
  request: Request,
  url: URL,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response> {
  const key = url.pathname.replace(/^\/+/, "")
  const isHead = request.method === "HEAD"

  if (key.length < 1) return htmlResponse(renderIndexPage(url.origin, config), { withBody: !isHead })

  // The expiry is part of the key, so the file stops being served on time even
  // if the R2 lifecycle rule (day granularity) has not removed it yet.
  if (isExpired(key)) {
    ctx.waitUntil(config.bucket.delete(key).catch((error) => console.error("expired object delete failed", error)))
    return notFound()
  }

  if (!isHead && !url.searchParams.has("raw") && prefersAccessPage(request, url, config)) {
    return await accessPageResponse(key, url, config)
  }

  if (isHead) {
    const object = await config.bucket.head(key)
    if (!object) return notFound()
    return new Response(null, { status: 200, headers: objectHeaders(object, key) })
  }

  let object: R2Object | R2ObjectBody | null
  try {
    // Passing the request headers lets R2 handle Range and conditional requests.
    object = await config.bucket.get(key, { range: request.headers, onlyIf: request.headers })
  } catch (error) {
    if (request.headers.has("range")) return await rangeNotSatisfiable(key, config)
    throw error
  }
  if (!object) return notFound()

  const headers = objectHeaders(object, key)
  const body = "body" in object ? object.body : null
  if (!body) {
    // R2 returned metadata only: a conditional request that was not satisfied.
    headers.delete("Content-Length")
    const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since")
    return new Response(null, { status: notModified ? 304 : 412, headers })
  }

  const range = resolveRange(object.range, object.size)
  if (request.headers.has("range") && range && (range.offset > 0 || range.length < object.size)) {
    headers.set("Content-Length", String(range.length))
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`)
    return new Response(body, { status: 206, headers })
  }

  return new Response(body, { status: 200, headers })
}

/** Browsers get the landing page; curl, scripts and `?raw` get the bytes. */
function prefersAccessPage(request: Request, url: URL, config: Config): boolean {
  if (config.rawOnlyHosts.includes(url.hostname.toLowerCase())) return false
  return (request.headers.get("user-agent") ?? "").includes("Mozilla")
}

async function accessPageResponse(key: string, url: URL, config: Config): Promise<Response> {
  const object = await config.bucket.head(key)
  if (!object) return notFound()

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
      expiresAt: parseExpiry(key),
      ttlSeconds: config.fileTtlSeconds,
    }),
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
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
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

async function rangeNotSatisfiable(key: string, config: Config): Promise<Response> {
  const object = await config.bucket.head(key)
  if (!object) return notFound()
  return textResponse("Range Not Satisfiable\n", 416, { "Content-Range": `bytes */${object.size}` })
}
