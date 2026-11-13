import type { Config } from "./config"
import { ALLOWED_METHODS } from "./cors"
import type { Env } from "./env"
import { errorResponse } from "./http"
import { decodeFilename, randomHex } from "./keys"
import { parseContentLength, validateFilename } from "./upload"

const STREAM_ID_RE = /^[0-9a-f]{12}$/

/**
 * Routes `/pipe/...` and `/stream/...` to the Durable Object for that pipe or
 * stream, or returns null for any other path.
 *
 *   PUT|POST /pipe/<name>                 send; GET the same path to receive
 *   POST     /stream/<name>               create: replies with a read link and a write link
 *   PUT|POST /stream/<id>/<name>?key=...  append (the write link)
 *   GET|HEAD /stream/<id>/<name>          read (the read link)
 *
 * Uploaded files always live under a `<random>-<expiry>/` prefix, so reserving
 * these two words takes nothing away from existing links.
 */
export async function handleChannel(request: Request, url: URL, env: Env, config: Config): Promise<Response | null> {
  const path = url.pathname.replace(/^\/+/, "")
  const slash = path.indexOf("/")
  const kind = slash === -1 ? path : path.slice(0, slash)
  if (kind !== "pipe" && kind !== "stream") return null
  const rest = slash === -1 ? "" : path.slice(slash + 1)

  const channels = env.CHANNELS
  if (!channels) return errorResponse("not_available", "Pipes and streams are not switched on for this server", 501)

  const isWrite = request.method === "PUT" || request.method === "POST"
  const isRead = request.method === "GET" || request.method === "HEAD"
  if (!isWrite && !isRead) {
    return errorResponse(
      "method_not_allowed",
      `Method not allowed: send PUT or POST to write and GET to read. Usage: ${url.origin}/llms.txt`,
      405,
      { Allow: ALLOWED_METHODS },
    )
  }
  // One request may carry as much as one stored file, whatever it is for.
  const declared = isWrite ? parseContentLength(request.headers.get("content-length")) : null
  if (declared !== null && declared > config.maxFileSizeBytes) {
    return errorResponse("too_large", `Invalid size: ${declared}, max size of one request = ${config.maxFileSizeBytes}`, 413)
  }
  const forward = (
    name: string,
    action: string,
    params: Record<string, string | number>,
    withBody = true,
  ): Promise<Response> => {
    const internal = new URL(`https://channel/${kind}/${action}`)
    for (const [key, value] of Object.entries(params)) internal.searchParams.set(key, String(value))
    // The original request goes along as it is: method, headers and a body
    // that is streamed, not buffered.
    const forwarded = withBody
      ? new Request(internal, request)
      : new Request(internal, { method: request.method, headers: request.headers })
    return channels.get(channels.idFromName(name)).fetch(forwarded)
  }

  if (kind === "pipe") {
    const invalid = validateFilename(rest, url, `${url.origin}/pipe/<name>`)
    if (invalid) return invalid
    if (request.method === "HEAD") {
      return errorResponse("method_not_allowed", "A pipe has nothing to look at: GET it to receive", 405, {
        Allow: "GET, PUT, POST, OPTIONS",
      })
    }
    const name = decodeFilename(rest).split("/").pop() ?? rest
    // A body without a declared length is held to the same limit as it arrives.
    return await forward(`pipe:${rest}`, isWrite ? "send" : "receive", {
      name,
      wait: config.pipeWaitSeconds,
      max: config.maxFileSizeBytes,
    })
  }

  const segments = rest.split("/")
  const [first = "", second] = segments

  // POST /stream/<name>: a new stream.
  if (segments.length === 1) {
    if (!isWrite) {
      return errorResponse(
        "not_found",
        `Not found. To start a stream: POST ${url.origin}/stream/<name>; then use the read and write links it replies with`,
        404,
      )
    }
    const invalid = validateFilename(first, url, `${url.origin}/stream/<name>`)
    if (invalid) return invalid
    // A stream starts empty. Data sent along with the create request would
    // otherwise vanish without a word, also when its length was not declared.
    if (declared !== null ? declared > 0 : request.body !== null && (await carriesData(request.body))) {
      return errorResponse(
        "body_not_allowed",
        "A new stream starts empty: create it with an empty POST, then send data to the write link it replies with",
        400,
      )
    }
    const id = randomHex(6)
    return await forward(`stream:${id}`, "create", {
      name: decodeFilename(first),
      key: randomHex(16),
      link: `${url.origin}/stream/${id}/${first}`,
      idle: config.streamIdleTtlSeconds,
      ttl: config.streamMaxTtlSeconds,
    }, false)
  }

  // /stream/<id>/<name>: an existing one.
  if (segments.length !== 2 || !STREAM_ID_RE.test(first) || second === undefined || second === "") {
    if (isWrite && !STREAM_ID_RE.test(first)) {
      return errorResponse(
        "invalid_filename",
        `A stream's name cannot contain "/". To start a stream: POST ${url.origin}/stream/<name>`,
        400,
      )
    }
    return errorResponse("not_found", "Not found: this is not a stream link", 404)
  }
  if (!isWrite) {
    return await forward(`stream:${first}`, "read", {
      ...searchParams(url, ["from", "wait", "follow"]),
      followFor: config.streamFollowSeconds,
    })
  }

  const key = url.searchParams.get("key")
  if (!key) {
    return errorResponse(
      "write_key_required",
      "This is the stream's read link. Writing needs the write link, the one that ends in ?key=...",
      403,
    )
  }
  return await forward(`stream:${first}`, "write", {
    key,
    ...searchParams(url, ["close"]),
    max: config.streamMaxBytes,
    requestMax: config.maxFileSizeBytes,
  })
}

/** How long a create request's undeclared body is given to show whether it holds anything. */
const CREATE_BODY_WAIT_MS = 1000

/**
 * Whether a body of undeclared length has any data in it. One that is still
 * open after a moment counts: something is being sent with the request.
 */
async function carriesData(body: ReadableStream<Uint8Array>): Promise<boolean> {
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const waitedLongEnough = new Promise<"open">((resolve) => {
    timer = setTimeout(() => resolve("open"), CREATE_BODY_WAIT_MS)
  })
  try {
    for (;;) {
      const result = await Promise.race([reader.read(), waitedLongEnough])
      if (result === "open") return true
      if (result.done) return false
      if (result.value.byteLength > 0) return true
    }
  } catch {
    return false // the client went away; there is no one to answer either way
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

/** The named query parameters that are present, including ones with no value (`?follow`). */
function searchParams(url: URL, names: string[]): Record<string, string> {
  const params: Record<string, string> = {}
  for (const name of names) {
    const value = url.searchParams.get(name)
    if (value !== null) params[name] = value
  }
  return params
}
