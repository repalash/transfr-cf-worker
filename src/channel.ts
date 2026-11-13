import { DurableObject } from "cloudflare:workers"
import { untrustedContentHeaders } from "./download"
import type { Env } from "./env"
import { errorResponse, jsonResponse, textResponse, wantsJson } from "./http"
import { contentTypeFor } from "./mime"

/**
 * One Durable Object per pipe or stream. Every request for the same pipe or
 * stream reaches the same object, which is what lets it connect a sender to a
 * receiver, put appends in order and tell readers about new bytes.
 *
 * A pipe keeps nothing: bytes go from the sender's request straight into the
 * receiver's response. A stream is stored in the object's own SQLite database
 * and deleted by an alarm when it expires.
 *
 * The worker (channels.ts) validates and routes. The requests it forwards here
 * use the internal paths below and carry everything else, limits included, as
 * query parameters, so this class needs no configuration of its own.
 */
export class Channel extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/pipe/send":
        return await this.pipeSend(request, url)
      case "/pipe/receive":
        return await this.pipeReceive(request, url)
      case "/stream/create":
        return this.streamCreate(request, url)
      case "/stream/write":
        return await this.streamWrite(request, url)
      case "/stream/read":
        return await this.streamRead(request, url)
      default:
        return errorResponse("not_found", "Not found", 404)
    }
  }

  // ---------------------------------------------------------------- pipe

  private sender: Sender | null = null
  private receiver: Receiver | null = null
  /** A transfer is under way: the name stays taken until it ends. */
  private transferring = false

  /** Holds the sender's request until a receiver is there, then streams the body across. */
  private pipeSend(request: Request, url: URL): Promise<Response> | Response {
    if (this.sender || this.transferring) {
      return errorResponse("pipe_busy", "Someone is already sending on this pipe. Pick another name.", 409)
    }
    const body = request.body
    if (!body) return errorResponse("empty_body", "Empty body, there is nothing to send", 400)

    const name = url.searchParams.get("name") ?? "download"
    const wait = number(url, "wait")
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.sender = null
        void body.cancel().catch(() => {})
        resolve(
          errorResponse(
            "pipe_timeout",
            `No receiver connected within ${wait} seconds. Start the receiver, then send again.`,
            408,
          ),
        )
      }, wait * 1000)
      const sender: Sender = {
        body,
        name,
        contentType: contentTypeFor(request.headers.get("content-type"), name) ?? "application/octet-stream",
        length: contentLength(request),
        maxBytes: number(url, "max"),
        resolve,
        timer,
      }
      this.sender = sender
      // A sender that gives up while waiting must not be paired with a
      // receiver that arrives later.
      request.signal.addEventListener("abort", () => {
        if (this.sender !== sender) return
        clearTimeout(timer)
        this.sender = null
      })
      this.joinPipe()
    })
  }

  /** Holds the receiver's request until a sender is there. */
  private pipeReceive(request: Request, url: URL): Promise<Response> | Response {
    if (this.receiver || this.transferring) {
      return errorResponse("pipe_busy", "Someone is already receiving on this pipe. Pick another name.", 409)
    }
    const wait = number(url, "wait")
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.receiver = null
        resolve(
          errorResponse(
            "pipe_timeout",
            `No sender connected within ${wait} seconds. Start the sender, then try again.`,
            408,
          ),
        )
      }, wait * 1000)
      const receiver: Receiver = { resolve, timer }
      this.receiver = receiver
      // Likewise a receiver that went away: the next sender should wait for
      // a live one instead of sending into nothing.
      request.signal.addEventListener("abort", () => {
        if (this.receiver !== receiver) return
        clearTimeout(timer)
        this.receiver = null
      })
      this.joinPipe()
    })
  }

  /** Once both sides are here, the sender's body becomes the receiver's response. */
  private joinPipe(): void {
    const sender = this.sender
    const receiver = this.receiver
    if (!sender || !receiver) return
    this.sender = null
    this.receiver = null
    clearTimeout(sender.timer)
    clearTimeout(receiver.timer)

    // With a known length the receiver gets a Content-Length, and a short
    // transfer shows up as an error on its side rather than a complete file.
    const { readable, writable } =
      sender.length !== null ? new FixedLengthStream(sender.length) : new IdentityTransformStream()
    let sent = 0
    let tooLarge = false
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // A declared length was checked before the pipe was joined; a body
        // without one is measured as it goes by.
        if (sent + chunk.byteLength > sender.maxBytes) {
          tooLarge = true
          controller.error(new Error("the body is larger than one request may be"))
          return
        }
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
    })

    const headers = new Headers({
      ...untrustedContentHeaders(sender.name, sender.contentType),
      "Cache-Control": "no-store",
    })
    if (sender.length !== null) headers.set("Content-Length", String(sender.length))
    receiver.resolve(new Response(readable, { headers }))
    this.transferring = true
    sender.body
      .pipeThrough(counter)
      .pipeTo(writable)
      .finally(() => {
        this.transferring = false
      })
      .then(
        () => sender.resolve(textResponse(`Sent ${sent} bytes\n`)),
        () =>
          sender.resolve(
            tooLarge
              ? errorResponse(
                  "too_large",
                  `The transfer was stopped after ${sent} bytes: one send can carry at most ${sender.maxBytes} bytes`,
                  413,
                )
              : errorResponse("pipe_broken", `The transfer stopped after ${sent} bytes: one side disconnected`, 502),
          ),
      )
  }

  // -------------------------------------------------------------- stream

  /** `undefined` until loaded, `null` when this object holds no stream. */
  private meta: StreamMeta | null | undefined
  /** Readers waiting for the next append, close or deletion. */
  private readonly waiting = new Set<() => void>()

  private streamCreate(request: Request, url: URL): Response {
    if (this.loadMeta()) return errorResponse("stream_exists", "This stream already exists", 409)
    const name = url.searchParams.get("name") ?? "stream"
    const now = Date.now()
    const meta: StreamMeta = {
      name,
      writeKey: url.searchParams.get("key") ?? "",
      contentType: contentTypeFor(request.headers.get("content-type"), name) ?? "application/octet-stream",
      createdAt: now,
      lastWrite: now,
      length: 0,
      closed: false,
      idleTtl: number(url, "idle"),
      maxTtl: number(url, "ttl"),
    }
    const sql = this.ctx.storage.sql
    sql.exec("CREATE TABLE IF NOT EXISTS chunks (start INTEGER PRIMARY KEY, data BLOB NOT NULL)")
    sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)")
    this.saveMeta(meta)
    void this.ctx.storage.setAlarm(this.expiresAt(meta))

    const link = url.searchParams.get("link") ?? ""
    const writeLink = `${link}?key=${meta.writeKey}`
    const expires = new Date(this.expiresAt(meta)).toISOString()
    if (wantsJson(request)) {
      return jsonResponse({
        url: link,
        write_url: writeLink,
        name,
        content_type: meta.contentType,
        length: 0,
        state: "open",
        expires_at: expires,
      })
    }
    return textResponse(`read: ${link}\nwrite: ${writeLink}\n`, 200, {
      "X-Expires-At": expires,
      "Access-Control-Expose-Headers": "X-Expires-At",
    })
  }

  /** Appends the request body, piece by piece, so readers see it while it is still arriving. */
  private async streamWrite(request: Request, url: URL): Promise<Response> {
    const meta = this.liveMeta()
    if (!meta) return streamNotFound()
    if (!sameKey(url.searchParams.get("key") ?? "", meta.writeKey)) {
      return errorResponse("wrong_write_key", "This is not the stream's write link", 403)
    }
    if (meta.closed) return errorResponse("stream_closed", "This stream has been closed and takes no more data", 409)

    const close = url.searchParams.has("close")
    const maxBytes = number(url, "max")
    // A declared length was checked by the worker; a body without one is cut
    // off here once it has carried as much as one request may.
    const requestMax = number(url, "requestMax")
    let appended = 0
    if (request.body) {
      // The body arrives in small network chunks. They are gathered for a
      // moment before being stored, so that a large upload is not written a
      // few kilobytes at a time, while readers still see new data within
      // FLUSH_AFTER_MS of it arriving.
      const reader = request.body.getReader()
      const gathered: Uint8Array[] = []
      let gatheredBytes = 0
      let flushDue: Promise<null> | null = null
      const flush = (): WriteProblem | null => {
        const piece = concat(gathered, gatheredBytes)
        gathered.length = 0
        gatheredBytes = 0
        flushDue = null
        const { added, problem } = this.appendUpTo(piece, maxBytes)
        appended += added
        return problem
      }

      let next = reader.read()
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array> | null
        try {
          result = flushDue ? await Promise.race([next, flushDue]) : await next
        } catch {
          // The writer's connection broke. What had arrived is still stored;
          // there is no one left to reply to.
          if (gatheredBytes > 0) flush()
          return errorResponse("upload_interrupted", `The upload was cut off. ${appended} bytes were added.`, 400)
        }
        let problem: WriteProblem | "request_too_large" | null = null
        if (result === null) {
          // Nothing more arrived for a while: store what there is.
          problem = flush()
        } else if (result.done) {
          break
        } else {
          const room = requestMax - appended - gatheredBytes
          if (result.value.byteLength > room) {
            // Keep the part that fits, as with a full stream, then stop.
            if (room > 0) {
              gathered.push(result.value.subarray(0, room))
              gatheredBytes += room
            }
            problem = (gatheredBytes > 0 ? flush() : null) ?? "request_too_large"
          } else {
            gathered.push(result.value)
            gatheredBytes += result.value.byteLength
            next = reader.read()
            if (gatheredBytes >= FLUSH_BYTES) problem = flush()
            else flushDue ??= new Promise((resolve) => setTimeout(() => resolve(null), FLUSH_AFTER_MS))
          }
        }
        if (problem) {
          void reader.cancel().catch(() => {})
          return problem === "request_too_large"
            ? errorResponse(
                "too_large",
                `One request can add at most ${requestMax} bytes. ${appended} bytes of this request were added; send the rest in another request.`,
                413,
              )
            : writeRefused(problem, appended, maxBytes)
        }
      }
      if (gatheredBytes > 0) {
        const problem = flush()
        if (problem) return writeRefused(problem, appended, maxBytes)
      }
    }
    if (appended === 0 && !close) {
      return errorResponse("empty_body", "Empty body, there is nothing to add to the stream", 400)
    }

    const after = this.liveMeta()
    if (!after) return streamNotFound()
    if (close) {
      // Closing counts as a write, so the stream is kept for its full time
      // after it ends, not after its last byte.
      after.closed = true
      after.lastWrite = Date.now()
      this.saveMeta(after)
      this.wake()
    }
    await this.ctx.storage.setAlarm(this.expiresAt(after))

    const state = after.closed ? "closed" : "open"
    if (wantsJson(request)) return jsonResponse({ appended, length: after.length, state })
    return textResponse(`Added ${appended} bytes. The stream is ${after.length} bytes and ${state}.\n`)
  }

  private async streamRead(request: Request, url: URL): Promise<Response> {
    let meta = this.liveMeta()
    if (!meta) return streamNotFound()

    const range = parseFrom(url.searchParams.get("from"), request.headers.get("range"))
    if (range === "invalid") {
      return errorResponse("invalid_offset", "The offset in ?from= or Range has to be a whole number of bytes", 400)
    }
    const from = range?.from ?? 0
    if (from > meta.length) {
      return errorResponse("range_not_satisfiable", `The stream is only ${meta.length} bytes long so far`, 416, {
        "Content-Range": `bytes */${meta.length}`,
        ...streamHeaders(meta, this.expiresAt(meta)),
      })
    }

    // ?wait=N: nothing new yet, so hold the request until there is, or N seconds pass.
    const wait = Math.min(Number(url.searchParams.get("wait")) || 0, MAX_WAIT_SECONDS)
    if (wait > 0 && from === meta.length && !meta.closed) {
      await this.changed(wait * 1000).promise
      meta = this.liveMeta()
      if (!meta) return streamNotFound()
    }

    const headers = new Headers({
      ...untrustedContentHeaders(meta.name, meta.contentType),
      ...streamHeaders(meta, this.expiresAt(meta)),
      "Cache-Control": "no-store",
    })
    if (request.method === "HEAD") {
      headers.set("Content-Length", String(meta.length - from))
      return new Response(null, { headers })
    }

    if (url.searchParams.has("follow")) {
      const deadline = Date.now() + number(url, "followFor") * 1000
      return new Response(this.bytes(from, null, deadline), { headers })
    }

    const end = meta.length
    const usesRange = range !== null && range.viaHeader
    if (usesRange) {
      // A Range request for a point at the very end has no bytes to return.
      if (from === end) {
        return errorResponse("range_not_satisfiable", `The stream is only ${end} bytes long so far`, 416, {
          "Content-Range": `bytes */${end}`,
        })
      }
      // The total is not known while the stream can still grow.
      headers.set("Content-Range", `bytes ${from}-${end - 1}/${meta.closed ? end : "*"}`)
    }
    const status = usesRange ? 206 : 200
    if (end === from) {
      headers.set("Content-Length", "0")
      return new Response(null, { status, headers })
    }
    headers.set("Content-Length", String(end - from))
    const { readable, writable } = new FixedLengthStream(end - from)
    void this.bytes(from, end, Number.POSITIVE_INFINITY)
      .pipeTo(writable)
      .catch(() => {})
    return new Response(readable, { status, headers })
  }

  override async alarm(): Promise<void> {
    const meta = this.loadMeta()
    if (meta && Date.now() < this.expiresAt(meta)) {
      await this.ctx.storage.setAlarm(this.expiresAt(meta))
      return
    }
    await this.destroy()
  }

  /** The stream's bytes from `from` up to `end`; with `end` null, keeps going as the stream grows. */
  private bytes(from: number, end: number | null, deadline: number): ReadableStream<Uint8Array> {
    let offset = from
    let pending: { cancel(): void } | null = null
    let cancelled = false
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (!cancelled) {
          const meta = this.liveMeta()
          const limit = meta ? (end ?? meta.length) : offset
          // A follower's time is up even if it is still behind the writer.
          // What is left of a closed stream is finite, so that is sent out.
          if (end === null && meta && !meta.closed && Date.now() >= deadline) {
            controller.close()
            return
          }
          if (offset < limit) {
            const piece = this.read(offset, limit)
            if (!piece) {
              controller.error(new Error("stream data is missing"))
              return
            }
            offset += piece.byteLength
            controller.enqueue(piece)
            return
          }
          const remaining = deadline - Date.now()
          if (end !== null || !meta || meta.closed || remaining <= 0) {
            controller.close()
            return
          }
          const change = this.changed(remaining)
          pending = change
          await change.promise
          pending = null
        }
      },
      cancel: () => {
        // The reader went away: stop waiting, so the object can go idle.
        cancelled = true
        pending?.cancel()
      },
    })
  }

  /** Resolves at the next append, close or deletion, or after `timeoutMs`. */
  private changed(timeoutMs: number): { promise: Promise<void>; cancel(): void } {
    let finish = () => {}
    const promise = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.waiting.delete(done)
        resolve()
      }
      // setTimeout takes a 32 bit count of milliseconds.
      const timer = setTimeout(done, Math.min(timeoutMs, 2_000_000_000))
      this.waiting.add(done)
      finish = done
    })
    return { promise, cancel: finish }
  }

  private wake(): void {
    for (const done of [...this.waiting]) done()
  }

  /**
   * Adds as much of `data` as the stream may still take, and says how many
   * bytes went in and, if not all of them did, why. The stream is looked up
   * afresh each time: it can expire or be closed by another request while this
   * one is still sending.
   */
  private appendUpTo(data: Uint8Array, maxBytes: number): { added: number; problem: WriteProblem | null } {
    const meta = this.liveMeta()
    if (!meta) return { added: 0, problem: "gone" }
    if (meta.closed) return { added: 0, problem: "closed" }
    // Fill the stream exactly to its limit, however the body happened to be split.
    const fits = data.subarray(0, Math.max(0, maxBytes - meta.length))
    for (let start = 0; start < fits.byteLength; start += MAX_ROW_BYTES) {
      this.store(meta, fits.subarray(start, start + MAX_ROW_BYTES))
    }
    if (fits.byteLength > 0) {
      meta.lastWrite = Date.now()
      this.saveMeta(meta)
      this.wake()
    }
    return { added: fits.byteLength, problem: fits.byteLength === data.byteLength ? null : "full" }
  }

  /**
   * Stores a piece of at most MAX_ROW_BYTES. A small piece is added to the
   * last row instead of getting a row of its own, so a stream written a line
   * at a time does not turn into millions of rows.
   */
  private store(meta: StreamMeta, piece: Uint8Array): void {
    const sql = this.ctx.storage.sql
    const last = sql
      .exec<{ start: number; size: number }>(
        "SELECT start, length(data) AS size FROM chunks ORDER BY start DESC LIMIT 1",
      )
      .toArray()[0]
    if (last && last.size + piece.byteLength <= MERGE_BELOW_BYTES) {
      const merged = new Uint8Array(last.size + piece.byteLength)
      const row = sql.exec<{ data: ArrayBuffer }>("SELECT data FROM chunks WHERE start = ?", last.start).one()
      merged.set(new Uint8Array(row.data), 0)
      merged.set(piece, last.size)
      sql.exec("UPDATE chunks SET data = ? WHERE start = ?", merged, last.start)
    } else {
      // A copy: the piece may be a view into a larger buffer.
      sql.exec("INSERT INTO chunks (start, data) VALUES (?, ?)", meta.length, piece.slice())
    }
    meta.length += piece.byteLength
  }

  /** The stored bytes starting at `offset`, from one row, stopping before `limit`. */
  private read(offset: number, limit: number): Uint8Array | null {
    const row = this.ctx.storage.sql
      .exec<{ start: number; data: ArrayBuffer }>(
        "SELECT start, data FROM chunks WHERE start <= ? ORDER BY start DESC LIMIT 1",
        offset,
      )
      .toArray()[0]
    if (!row) return null
    const data = new Uint8Array(row.data)
    const begin = offset - row.start
    if (begin >= data.byteLength) return null
    return data.subarray(begin, Math.min(data.byteLength, limit - row.start))
  }

  private loadMeta(): StreamMeta | null {
    if (this.meta !== undefined) return this.meta
    const sql = this.ctx.storage.sql
    // Without this check a read of a stream that never existed would create
    // tables, and so storage, for it.
    const exists = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0
    const row = exists ? sql.exec<{ json: string }>("SELECT json FROM meta WHERE id = 1").toArray()[0] : undefined
    this.meta = row ? (JSON.parse(row.json) as StreamMeta) : null
    return this.meta
  }

  /** The stream if there is one and it has not expired; an expired one is deleted on the way. */
  private liveMeta(): StreamMeta | null {
    const meta = this.loadMeta()
    if (!meta) return null
    if (Date.now() >= this.expiresAt(meta)) {
      void this.destroy()
      return null
    }
    return meta
  }

  private saveMeta(meta: StreamMeta): void {
    this.meta = meta
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO meta (id, json) VALUES (1, ?)", JSON.stringify(meta))
  }

  /** When the stream is deleted, in milliseconds: so long after the last write, and after creation at the latest. */
  private expiresAt(meta: StreamMeta): number {
    return Math.min(meta.lastWrite + meta.idleTtl * 1000, meta.createdAt + meta.maxTtl * 1000)
  }

  private async destroy(): Promise<void> {
    this.meta = null
    this.wake()
    await this.ctx.storage.deleteAll()
  }
}

/** SQLite in a Durable Object takes values up to 2 MB; stay well under it. */
const MAX_ROW_BYTES = 1024 * 1024
/** An append is added to the last row while that keeps the row under this size. */
const MERGE_BELOW_BYTES = 64 * 1024
/** Incoming data is stored once this much has gathered... */
const FLUSH_BYTES = 256 * 1024
/** ...or this long after the first of it arrived, whichever is sooner. */
const FLUSH_AFTER_MS = 50

type WriteProblem = "gone" | "closed" | "full"

function writeRefused(problem: WriteProblem, appended: number, maxBytes: number): Response {
  switch (problem) {
    case "gone":
      return streamNotFound()
    case "closed":
      return errorResponse("stream_closed", "This stream has been closed and takes no more data", 409)
    case "full":
      return errorResponse(
        "stream_full",
        `The stream is full: the limit is ${maxBytes} bytes. ${appended} bytes of this request were added.`,
        413,
      )
  }
}

function concat(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1 && pieces[0]) return pieces[0]
  const joined = new Uint8Array(total)
  let offset = 0
  for (const piece of pieces) {
    joined.set(piece, offset)
    offset += piece.byteLength
  }
  return joined
}
/** Longest a `?wait=` request is held. */
const MAX_WAIT_SECONDS = 60

interface Sender {
  body: ReadableStream<Uint8Array>
  name: string
  contentType: string
  length: number | null
  /** The most one send may carry. */
  maxBytes: number
  resolve(response: Response): void
  timer: ReturnType<typeof setTimeout>
}

interface Receiver {
  resolve(response: Response): void
  timer: ReturnType<typeof setTimeout>
}

interface StreamMeta {
  name: string
  writeKey: string
  contentType: string
  /** Milliseconds since the epoch. */
  createdAt: number
  lastWrite: number
  length: number
  closed: boolean
  /** Seconds after the last write, and after creation, that the stream is deleted. Fixed when it is created. */
  idleTtl: number
  maxTtl: number
}

/** A limit the worker passed along with the request. */
function number(url: URL, name: string): number {
  return Number(url.searchParams.get(name))
}

function contentLength(request: Request): number | null {
  const header = request.headers.get("content-length")
  if (header === null || !/^\d+$/.test(header.trim())) return null
  const length = Number(header.trim())
  return Number.isSafeInteger(length) ? length : null
}

function streamNotFound(): Response {
  return errorResponse("not_found", "Not found: the link is wrong, or the stream has expired", 404)
}

function streamHeaders(meta: StreamMeta, expiresAt: number): Record<string, string> {
  return {
    "X-Stream-Length": String(meta.length),
    "X-Stream-State": meta.closed ? "closed" : "open",
    "X-Expires-At": new Date(expiresAt).toISOString(),
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Content-Type, Content-Disposition, X-Stream-Length, X-Stream-State, X-Expires-At, X-Error-Code",
  }
}

/**
 * Where a read starts: `?from=N`, or a `Range: bytes=N-` header. Only an open
 * ended range is taken from the header; anything else there is ignored.
 */
function parseFrom(from: string | null, range: string | null): { from: number; viaHeader: boolean } | "invalid" | null {
  if (from !== null) {
    if (!/^\d+$/.test(from)) return "invalid"
    const offset = Number(from)
    return Number.isSafeInteger(offset) ? { from: offset, viaHeader: false } : "invalid"
  }
  const match = /^bytes=(\d+)-$/.exec(range?.trim() ?? "")
  if (!match) return null
  const offset = Number(match[1])
  return Number.isSafeInteger(offset) ? { from: offset, viaHeader: true } : null
}

/** Compares two secrets without stopping at the first difference. */
function sameKey(given: string, expected: string): boolean {
  if (expected.length === 0 || given.length !== expected.length) return false
  let difference = 0
  for (let i = 0; i < expected.length; i++) difference |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return difference === 0
}
