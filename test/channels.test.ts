import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Env } from "../src/env"
import worker from "../src/index"

const ORIGIN = "https://transfr.test"

async function call(request: Request, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, { ...env, ...overrides } as Env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

function put(path: string, body: BodyInit | null, headers: Record<string, string> = {}, overrides = {}) {
  return call(new Request(`${ORIGIN}${path}`, { method: "PUT", body, headers }), overrides)
}

function get(path: string, headers: Record<string, string> = {}, overrides = {}) {
  return call(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, { headers }), overrides)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A body with no known length, sent in the given pieces. */
function chunked(...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(typeof part === "string" ? encoder.encode(part) : part)
      controller.close()
    },
  })
}

/** `toEqual` on megabytes of bytes takes seconds; this does not. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  // getRandomValues takes at most 65536 bytes at a time.
  for (let offset = 0; offset < length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65_536)))
  }
  return bytes
}

let counter = 0
/** A pipe name no other test uses. */
const pipeName = () => `/pipe/test-${Date.now()}-${counter++}`

describe("pipe", () => {
  it("passes the sender's bytes to the receiver, sender first", async () => {
    const path = pipeName()
    const data = randomBytes(300_000)
    const sending = put(path, data)
    const received = await get(path)

    expect(received.status).toBe(200)
    expect(received.headers.get("content-length")).toBe("300000")
    expect(received.headers.get("content-disposition")).toMatch(/^attachment;/)
    expect(received.headers.get("x-content-type-options")).toBe("nosniff")
    expect(received.headers.get("cache-control")).toBe("no-store")
    expect(received.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    expect(sameBytes(new Uint8Array(await received.arrayBuffer()), data)).toBe(true)

    const sent = await sending
    expect(sent.status).toBe(200)
    expect(await sent.text()).toBe("Sent 300000 bytes\n")
  })

  it("works when the receiver is there first", async () => {
    const path = pipeName()
    const receiving = get(path)
    await sleep(20)
    const sending = put(path, "hello through the pipe")
    const received = await receiving
    expect(await received.text()).toBe("hello through the pipe")
    expect(await (await sending).text()).toBe("Sent 22 bytes\n")
  })

  it("passes a body of unknown length, and takes the type from the name", async () => {
    const path = `${pipeName()}.txt`
    const sending = put(path, chunked("line 1\n", "line 2\n"))
    const received = await get(path)
    expect(received.headers.get("content-length")).toBeNull()
    expect(received.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(received.headers.get("content-disposition")).toMatch(/^inline;/)
    expect(await received.text()).toBe("line 1\nline 2\n")
    expect(await (await sending).text()).toBe("Sent 14 bytes\n")
  })

  it("stores nothing", async () => {
    const path = pipeName()
    const sending = put(path, "ephemeral")
    await (await get(path)).text()
    await sending
    const bucket = env[env.R2_DEFAULT_NAMESPACE] as R2Bucket
    expect((await bucket.list()).objects).toHaveLength(0)
  })

  it("gives up when the other side never comes", async () => {
    const quick = { PIPE_WAIT_SECONDS: "1" }
    const noSender = await get(pipeName(), {}, quick)
    expect(noSender.status).toBe(408)
    expect(noSender.headers.get("x-error-code")).toBe("pipe_timeout")
    expect(await noSender.text()).toContain("No sender connected within 1 seconds")

    const noReceiver = await put(pipeName(), "data", {}, quick)
    expect(noReceiver.status).toBe(408)
    expect(await noReceiver.text()).toContain("No receiver connected within 1 seconds")
  })

  it("allows one sender and one receiver at a time on a name", async () => {
    const path = pipeName()
    const first = put(path, "first")
    await sleep(20)
    const second = await put(path, "second")
    expect(second.status).toBe(409)
    expect(second.headers.get("x-error-code")).toBe("pipe_busy")
    // The first sender is still waiting, and gets its receiver.
    expect(await (await get(path)).text()).toBe("first")
    await first

    const other = pipeName()
    const waiting = get(other, {}, { PIPE_WAIT_SECONDS: "1" })
    await sleep(20)
    expect((await get(other)).status).toBe(409)
    expect((await waiting).status).toBe(408)
  })

  it("can be reused once a transfer is over", async () => {
    const path = pipeName()
    for (const text of ["one", "two"]) {
      const sending = put(path, text)
      expect(await (await get(path)).text()).toBe(text)
      await sending
    }
  })

  it("answers methods other than GET, PUT and POST with 405, on pipes and streams", async () => {
    const { read, write } = await createStream()
    await append(write, "data")
    for (const [method, url] of [
      ["DELETE", read],
      ["PATCH", read],
      ["DELETE", write],
      ["DELETE", `${ORIGIN}${pipeName()}`],
    ]) {
      const response = await call(new Request(url, { method }))
      expect(response.status, `${method} ${url}`).toBe(405)
      expect(response.headers.get("x-error-code")).toBe("method_not_allowed")
      expect(response.headers.get("allow")).toBe("GET, HEAD, POST, PUT, OPTIONS")
    }
    expect(await (await get(read)).text()).toBe("data")
  })

  it("refuses a pipe without a name, an empty send and HEAD", async () => {
    const noName = await put("/pipe/", "data")
    expect(noName.status).toBe(400)
    expect(noName.headers.get("x-error-code")).toBe("no_filename")
    expect(await noName.text()).toContain("like https://transfr.test/pipe/<name>")
    expect((await put("/pipe", "data")).status).toBe(400)

    const empty = await put(pipeName(), null)
    expect(empty.status).toBe(400)
    expect(empty.headers.get("x-error-code")).toBe("empty_body")

    const head = await call(new Request(`${ORIGIN}${pipeName()}`, { method: "HEAD" }))
    expect(head.status).toBe(405)
    expect(head.headers.get("allow")).toBe("GET, PUT, POST, OPTIONS")
  })
})

/** Creates a stream and returns its two links. */
async function createStream(name = "build.log", overrides = {}): Promise<{ read: string; write: string }> {
  const response = await call(new Request(`${ORIGIN}/stream/${name}`, { method: "POST" }), overrides)
  expect(response.status).toBe(200)
  const text = await response.text()
  const read = /^read: (.+)$/m.exec(text)?.[1] ?? ""
  const write = /^write: (.+)$/m.exec(text)?.[1] ?? ""
  return { read, write }
}

function append(write: string, body: BodyInit | null, options: { close?: boolean } = {}, overrides = {}) {
  return call(new Request(options.close ? `${write}&close` : write, { method: "POST", body }), overrides)
}

describe("stream", () => {
  it("is created with a read link and a secret write link", async () => {
    const before = Date.now()
    const response = await call(new Request(`${ORIGIN}/stream/build.log`, { method: "POST" }))
    const text = await response.text()
    expect(text).toMatch(
      /^read: https:\/\/transfr\.test\/stream\/([0-9a-f]{12})\/build\.log\nwrite: https:\/\/transfr\.test\/stream\/\1\/build\.log\?key=[0-9a-f]{32}\n$/,
    )
    // Deleted 24 hours after the last write.
    const expires = Date.parse(response.headers.get("x-expires-at") ?? "")
    expect(expires).toBeGreaterThan(before + 86_000_000)
    expect(expires).toBeLessThanOrEqual(Date.now() + 86_400_000)
  })

  it("is created with JSON when asked", async () => {
    const response = await call(
      new Request(`${ORIGIN}/stream/data.json`, { method: "POST", headers: { accept: "application/json" } }),
    )
    const body = (await response.json()) as Record<string, string | number>
    expect(body).toMatchObject({ name: "data.json", content_type: "application/json", length: 0, state: "open" })
    expect(body.write_url).toBe(`${body.url}?key=${String(body.write_url).split("key=")[1]}`)
  })

  it("can be read while it grows, in full or from an offset", async () => {
    const { read, write } = await createStream()
    expect(await (await get(read)).text()).toBe("")

    expect(await (await append(write, "step 1\n")).text()).toBe("Added 7 bytes. The stream is 7 bytes and open.\n")
    expect(await (await append(write, "step 2\n")).text()).toBe("Added 7 bytes. The stream is 14 bytes and open.\n")

    const all = await get(read)
    expect(all.status).toBe(200)
    expect(all.headers.get("content-length")).toBe("14")
    expect(all.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(all.headers.get("x-stream-length")).toBe("14")
    expect(all.headers.get("x-stream-state")).toBe("open")
    expect(all.headers.get("cache-control")).toBe("no-store")
    expect(all.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await all.text()).toBe("step 1\nstep 2\n")

    expect(await (await get(`${read}?from=7`)).text()).toBe("step 2\n")
    // At the very end there is nothing new yet: an empty reply, not an error.
    const caughtUp = await get(`${read}?from=14`)
    expect(caughtUp.status).toBe(200)
    expect(caughtUp.headers.get("content-length")).toBe("0")
    expect(await caughtUp.text()).toBe("")
  })

  it("answers a Range request, with an unknown total while the stream is open", async () => {
    const { read, write } = await createStream()
    await append(write, "0123456789")
    const open = await get(read, { range: "bytes=4-" })
    expect(open.status).toBe(206)
    expect(open.headers.get("content-range")).toBe("bytes 4-9/*")
    expect(await open.text()).toBe("456789")

    await append(write, null, { close: true })
    const closed = await get(read, { range: "bytes=4-" })
    expect(closed.headers.get("content-range")).toBe("bytes 4-9/10")
    await closed.text()

    // A Range header of another shape is ignored, as HTTP allows.
    const ignored = await get(read, { range: "bytes=2-3" })
    expect(ignored.status).toBe(200)
    expect(await ignored.text()).toBe("0123456789")
  })

  it("refuses an offset past the end or one that is not a number", async () => {
    const { read, write } = await createStream()
    await append(write, "0123456789")
    for (const response of [await get(`${read}?from=11`), await get(read, { range: "bytes=10-" })]) {
      expect(response.status).toBe(416)
      expect(response.headers.get("x-error-code")).toBe("range_not_satisfiable")
      expect(response.headers.get("content-range")).toBe("bytes */10")
    }
    const invalid = await get(`${read}?from=abc`)
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get("x-error-code")).toBe("invalid_offset")
  })

  it("answers HEAD with the length and state and no body", async () => {
    const { read, write } = await createStream()
    await append(write, "0123456789")
    const head = await call(new Request(read, { method: "HEAD" }))
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("10")
    expect(head.headers.get("x-stream-length")).toBe("10")
    expect(await head.text()).toBe("")
  })

  it("only takes data through the write link", async () => {
    const { read, write } = await createStream()
    const viaReadLink = await call(new Request(read, { method: "POST", body: "nope" }))
    expect(viaReadLink.status).toBe(403)
    expect(viaReadLink.headers.get("x-error-code")).toBe("write_key_required")

    for (const key of ["wrong", "0".repeat(32), ""]) {
      const response = await call(new Request(`${read}?key=${key}`, { method: "POST", body: "nope" }))
      expect(response.status, key).toBe(403)
    }
    expect((await append(write, null)).headers.get("x-error-code")).toBe("empty_body")
    expect(await (await get(read)).text()).toBe("")
  })

  it("takes no more data once closed", async () => {
    const { read, write } = await createStream()
    const last = await append(write, "the end\n", { close: true })
    expect(await last.text()).toBe("Added 8 bytes. The stream is 8 bytes and closed.\n")
    expect((await get(read)).headers.get("x-stream-state")).toBe("closed")

    const late = await append(write, "more")
    expect(late.status).toBe(409)
    expect(late.headers.get("x-error-code")).toBe("stream_closed")
    expect(await (await get(read)).text()).toBe("the end\n")
  })

  it("keeps a stream for its full time after it is closed, not after its last byte", async () => {
    const { read, write } = await createStream()
    await append(write, "data")
    const before = Date.parse((await get(read)).headers.get("x-expires-at") ?? "")
    await sleep(1_100)
    expect(await (await append(write, null, { close: true })).text()).toBe(
      "Added 0 bytes. The stream is 4 bytes and closed.\n",
    )
    const after = Date.parse((await get(read)).headers.get("x-expires-at") ?? "")
    expect(after - before).toBeGreaterThanOrEqual(1_000)
  })

  it("refuses data sent along with the request that creates a stream", async () => {
    const response = await call(
      new Request(`${ORIGIN}/stream/build.log`, { method: "POST", body: "first line", headers: { "content-length": "10" } }),
    )
    expect(response.status).toBe(400)
    expect(response.headers.get("x-error-code")).toBe("body_not_allowed")
    expect(await response.text()).toContain("send data to the write link")

    const noName = await call(new Request(`${ORIGIN}/stream/`, { method: "POST" }))
    expect(noName.headers.get("x-error-code")).toBe("no_filename")
    expect(await noName.text()).toContain("like https://transfr.test/stream/<name>")
  })

  it("keeps the error code readable to browser scripts on every stream error", async () => {
    const { read } = await createStream()
    const response = await get(`${read}?from=999`)
    expect(response.status).toBe(416)
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Error-Code")
  })

  it("says why a stream name with a slash is refused", async () => {
    const response = await call(new Request(`${ORIGIN}/stream/logs/build.log`, { method: "POST" }))
    expect(response.status).toBe(400)
    expect(response.headers.get("x-error-code")).toBe("invalid_filename")
    expect(await response.text()).toContain(`cannot contain "/"`)
  })

  it("returns exactly what was written, across large and tiny appends", async () => {
    const { read, write } = await createStream("blob.bin")
    // Larger than one stored row, then many appends small enough to be merged
    // into a row, then a body that arrives in uneven pieces.
    const big = randomBytes(2_500_000)
    const small = Array.from({ length: 40 }, (_, index) => randomBytes(1 + index * 37))
    const uneven = [randomBytes(300_000), randomBytes(5), randomBytes(1_200_000)]
    await append(write, big)
    for (const piece of small) await append(write, piece)
    await append(write, chunked(...uneven))

    const expected = new Uint8Array([big, ...small, ...uneven].reduce((total, piece) => total + piece.byteLength, 0))
    let offset = 0
    for (const piece of [big, ...small, ...uneven]) {
      expected.set(piece, offset)
      offset += piece.byteLength
    }

    const all = await get(read)
    expect(all.headers.get("content-length")).toBe(String(expected.byteLength))
    const got = new Uint8Array(await all.arrayBuffer())
    expect(got.byteLength).toBe(expected.byteLength)
    expect(sameBytes(got, expected)).toBe(true)

    // Offsets on, just before and just after the boundaries between stored rows.
    for (const from of [0, 1, 1_048_575, 1_048_576, 1_048_577, 2_499_999, 2_500_000, 2_500_001, 2_530_000, 3_900_000]) {
      const part = new Uint8Array(await (await get(`${read}?from=${from}`)).arrayBuffer())
      expect(part.byteLength, String(from)).toBe(expected.byteLength - from)
      expect(sameBytes(part, expected.subarray(from)), String(from)).toBe(true)
    }
  })

  it("holds a ?wait read until new bytes arrive", async () => {
    const { read, write } = await createStream()
    await append(write, "old\n")
    const started = Date.now()
    const waiting = get(`${read}?from=4&wait=20`)
    await sleep(150)
    await append(write, "new\n")
    const response = await waiting
    expect(await response.text()).toBe("new\n")
    expect(response.headers.get("x-stream-length")).toBe("8")
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("answers a ?wait read empty when nothing arrives, and at once when there is data or the stream is closed", async () => {
    const { read, write } = await createStream()
    await append(write, "data\n")

    const started = Date.now()
    const nothing = await get(`${read}?from=5&wait=1`)
    expect(nothing.status).toBe(200)
    expect(await nothing.text()).toBe("")
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)

    const immediate = Date.now()
    expect(await (await get(`${read}?from=0&wait=20`)).text()).toBe("data\n")
    await append(write, null, { close: true })
    expect(await (await get(`${read}?from=5&wait=20`)).text()).toBe("")
    expect(Date.now() - immediate).toBeLessThan(2_000)
  })

  it("follows a stream: what is there, then each append, until it is closed", async () => {
    const { read, write } = await createStream()
    await append(write, "one\n")
    const response = await get(`${read}?follow`)
    expect(response.headers.get("content-length")).toBeNull()
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    const next = async () => {
      const { done, value } = await reader.read()
      return done ? null : decoder.decode(value)
    }

    expect(await next()).toBe("one\n")
    await append(write, "two\n")
    expect(await next()).toBe("two\n")
    await append(write, "three\n", { close: true })
    expect(await next()).toBe("three\n")
    expect(await next()).toBeNull()
  })

  it("ends a follow after the configured time, and when the reader goes away", async () => {
    const { read, write } = await createStream()
    await append(write, "one\n")
    const brief = await get(`${read}?follow`, {}, { STREAM_FOLLOW_SECONDS: "1" })
    const started = Date.now()
    expect(await brief.text()).toBe("one\n")
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)

    const abandoned = await get(`${read}?follow`)
    const reader = abandoned.body!.getReader()
    await reader.read()
    await reader.cancel()
    // The stream itself is unaffected.
    await append(write, "two\n")
    expect(await (await get(read)).text()).toBe("one\ntwo\n")
  })

  it("stops growing at its size limit and says how much was added", async () => {
    const limit = { STREAM_MAX_BYTES: "10" }
    const { read, write } = await createStream("small.log", limit)
    expect((await append(write, "12345678", {}, limit)).status).toBe(200)
    const full = await append(write, chunked("9", "0", "overflow"), {}, limit)
    expect(full.status).toBe(413)
    expect(full.headers.get("x-error-code")).toBe("stream_full")
    expect(await full.text()).toContain("2 bytes of this request were added")
    expect(await (await get(read)).text()).toBe("1234567890")
  })

  it("is deleted when its time is up, counted from the last write", async () => {
    const short = { STREAM_IDLE_TTL: "2" }
    const { read, write } = await createStream("brief.log", short)
    await sleep(1_200)
    // A write pushes the expiry back.
    expect((await append(write, "still here\n", {}, short)).status).toBe(200)
    await sleep(1_200)
    expect(await (await get(read)).text()).toBe("still here\n")
    await sleep(1_200)

    const gone = await get(read)
    expect(gone.status).toBe(404)
    expect(gone.headers.get("x-error-code")).toBe("not_found")
    expect((await append(write, "too late")).status).toBe(404)
  })

  it("is deleted after its maximum lifetime however recently it was written", async () => {
    const capped = { STREAM_IDLE_TTL: "100", STREAM_MAX_TTL: "1" }
    const { read, write } = await createStream("capped.log", capped)
    await append(write, "data")
    await sleep(1_200)
    expect((await get(read)).status).toBe(404)
  })

  it("ends a follow when the stream expires", async () => {
    const { read, write } = await createStream("expiring.log", { STREAM_IDLE_TTL: "1" })
    await append(write, "one\n")
    const response = await get(`${read}?follow`)
    const started = Date.now()
    expect(await response.text()).toBe("one\n")
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it("404s for links that are not a stream", async () => {
    for (const path of ["/stream/000000000000/nope.log", "/stream/not-an-id/x.log", "/stream/a/b/c", "/stream/"]) {
      const response = await get(path)
      expect(response.status, path).toBe(404)
      await response.text()
    }
    // The id finds the stream; the name after it is only a label.
    const { read } = await createStream()
    expect((await get(read.replace("build.log", "other.log"))).status).toBe(200)
    const hint = await get("/stream/build.log")
    expect(await hint.text()).toContain("POST https://transfr.test/stream/<name>")
  })

  it("gives errors as JSON when asked", async () => {
    const response = await get("/stream/000000000000/nope.log", { accept: "application/json" })
    expect(await response.json()).toEqual({
      error: "Not found: the link is wrong, or the stream has expired",
      code: "not_found",
      status: 404,
    })
  })
})

describe("limits on sending", () => {
  const limiter = (success: boolean, seen: string[] = []) => ({
    UPLOAD_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        seen.push(key)
        return { success }
      },
    },
  })
  const from = (address: string) => ({ "cf-connecting-ip": address })

  it("refuses uploads, pipe sends and stream writes from an address that is over its limit", async () => {
    for (const path of ["/file.txt", "/pipe/limited", "/stream/limited.log"]) {
      const response = await put(path, "data", from("203.0.113.9"), limiter(false))
      expect(response.status, path).toBe(429)
      expect(response.headers.get("x-error-code")).toBe("rate_limited")
      expect(response.headers.get("retry-after")).toBe("60")
    }
  })

  it("counts each address separately, and never limits reading", async () => {
    const seen: string[] = []
    expect((await put("/a.txt", "data", from("203.0.113.9"), limiter(true, seen))).status).toBe(200)
    expect((await put("/b.txt", "data", from("2001:db8::1"), limiter(true, seen))).status).toBe(200)
    expect(seen).toEqual(["203.0.113.9", "2001:db8::1"])

    const read = await get("/llms.txt", from("203.0.113.9"), limiter(false, seen))
    expect(read.status).toBe(200)
    expect(seen).toHaveLength(2)
  })

  it("does not limit when there is no client address or no limiter", async () => {
    expect((await put("/a.txt", "data", {}, limiter(false))).status).toBe(200)
    expect((await put("/b.txt", "data", from("203.0.113.9"), { UPLOAD_LIMITER: undefined })).status).toBe(200)
  })
})

describe("documentation and limits shared with files", () => {
  it("refuses a pipe send or stream write larger than one stored file may be", async () => {
    const small = { R2_MAX_FILE_SIZE_BYTES: "10" }
    const { write } = await createStream("limited.log", small)
    for (const path of ["/pipe/too-big", write.replace(ORIGIN, "")]) {
      const response = await put(path, "x".repeat(11), { "content-length": "11" }, small)
      expect(response.status, path).toBe(413)
      expect(response.headers.get("x-error-code")).toBe("too_large")
    }
  })

  it("explains pipes and streams in the text guide, with the configured limits", async () => {
    const guide = await (await get("/llms.txt")).text()
    expect(guide).not.toContain("{{")
    expect(guide).toContain("curl -T ./backup.tar https://transfr.test/pipe/7f3a9c-backup")
    expect(guide).toContain("it waits, for up to 5 minutes, until")
    expect(guide).toContain("curl -X POST https://transfr.test/stream/build.log")
    expect(guide).toContain("A stream holds up to 1.0 GB, and one write carries up to 95 MB")
    expect(guide).toContain("deleted 24 hours after its last write, and 7 days after it was")
    expect(guide).toContain("closed, and after 1 hour at the latest")
  })

  it("mentions both on the landing page", async () => {
    const html = await (await get("/", { accept: "text/html" })).text()
    expect(html).not.toContain("{{")
    expect(html).toContain("curl -T ./backup.tar https://transfr.test/pipe/7f3a9c-backup")
    expect(html).toContain("A stream holds up to <code>1.0 GB</code> and is deleted <code>24 hours</code>")
  })
})

describe("without the Durable Object binding", () => {
  it("says pipes and streams are switched off, and still stores files", async () => {
    const off = { CHANNELS: undefined }
    for (const response of [await get("/pipe/x", {}, off), await put("/stream/x.log", "data", {}, off)]) {
      expect(response.status).toBe(501)
      expect(response.headers.get("x-error-code")).toBe("not_available")
    }
    expect((await put("/plain.txt", "data", {}, off)).status).toBe(200)
  })
})
