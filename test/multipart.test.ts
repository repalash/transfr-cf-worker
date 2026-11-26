import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import type { Env } from "../src/env"
import worker from "../src/index"

const ORIGIN = "https://transfr.test"
const MB = 1024 * 1024
/** Small parts and limit, so the tests move a few MB instead of 250. */
const SMALL = {
  R2_MAX_FILE_SIZE_BYTES: String(6 * MB),
  R2_MULTIPART_PART_SIZE_BYTES: String(5 * MB),
  R2_MAX_MULTIPART_FILE_SIZE_BYTES: String(12 * MB),
}
const JSON_ACCEPT = { accept: "application/json" }

async function call(request: Request, overrides: Record<string, unknown> = SMALL): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, { ...env, ...overrides } as Env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

function bytes(length: number, seed: number): Uint8Array {
  const data = new Uint8Array(length)
  for (let i = 0; i < length; i++) data[i] = (i * 31 + seed) & 0xff
  return data
}

interface Started {
  key: string
  upload_id: string
  part_size: number
  part_count: number
  upload_url: string
}

async function start(name: string, size: number): Promise<Started> {
  const response = await call(new Request(`${ORIGIN}/${name}?uploads&size=${size}`, { method: "POST", headers: JSON_ACCEPT }))
  expect(response.status).toBe(200)
  return (await response.json()) as Started
}

async function sendPart(started: Started, part: number, data: Uint8Array): Promise<Response> {
  return await call(
    new Request(`${started.upload_url}&part=${part}`, {
      method: "PUT",
      body: data,
      headers: { "content-length": String(data.byteLength) },
    }),
  )
}

async function finish(started: Started, parts: { part: number; etag: string }[], headers: Record<string, string> = {}) {
  return await call(
    new Request(`${started.upload_url}&complete`, { method: "POST", body: JSON.stringify({ parts }), headers }),
  )
}

describe("large uploads in parts", () => {
  it("joins the parts into one file with one link, in the usual key layout", async () => {
    const file = bytes(11 * MB + 123, 7)
    const started = await start("big%20scan.glb", file.byteLength)
    expect(started.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{1,2}\/big%20scan\.glb$/)
    expect(started.part_size).toBe(5 * MB)
    expect(started.part_count).toBe(3)

    const parts: { part: number; etag: string }[] = []
    for (let part = 1; part <= started.part_count; part++) {
      const slice = file.subarray((part - 1) * started.part_size, part * started.part_size)
      const response = await sendPart(started, part, slice)
      expect(response.status).toBe(200)
      parts.push((await response.json()) as { part: number; etag: string })
    }

    const done = await finish(started, parts, JSON_ACCEPT)
    expect(done.status).toBe(200)
    const reply = (await done.json()) as Record<string, unknown>
    expect(reply).toMatchObject({
      url: `${ORIGIN}/${started.key}`,
      name: "big scan.glb",
      size: file.byteLength,
      content_type: "application/octet-stream",
    })

    const download = await call(new Request(`${ORIGIN}/${started.key}?raw=1`))
    expect(download.status).toBe(200)
    const got = new Uint8Array(await download.arrayBuffer())
    expect(got.byteLength).toBe(file.byteLength)
    expect(got.every((value, i) => value === file[i])).toBe(true)
  })

  it("answers the finish with the bare link when JSON is not asked for", async () => {
    const started = await start("small.bin", 10)
    const part = (await (await sendPart(started, 1, bytes(10, 1))).json()) as { part: number; etag: string }
    const done = await finish(started, [part])
    expect(await done.text()).toBe(`${ORIGIN}/${started.key}\n`)
    expect(done.headers.get("x-expires-at")).not.toBeNull()
  })

  it("refuses a file over the limit, and parts that are too large or out of range", async () => {
    const tooBig = await call(new Request(`${ORIGIN}/huge.bin?uploads&size=${12 * MB + 1}`, { method: "POST" }))
    expect(tooBig.status).toBe(413)
    expect(tooBig.headers.get("x-error-code")).toBe("too_large")

    const noSize = await call(new Request(`${ORIGIN}/huge.bin?uploads`, { method: "POST" }))
    expect(noSize.headers.get("x-error-code")).toBe("invalid_size")

    const started = await start("file.bin", 6 * MB)
    const oversized = await sendPart(started, 1, bytes(5 * MB + 1, 2))
    expect(oversized.status).toBe(413)
    // 12 MB in 5 MB parts is at most 3 parts.
    expect((await sendPart(started, 4, bytes(10, 2))).headers.get("x-error-code")).toBe("invalid_part")
    expect((await sendPart(started, 0, bytes(10, 2))).headers.get("x-error-code")).toBe("invalid_part")
  })

  it("rejects a bad finish, a wrong upload id and an address the worker did not make", async () => {
    const started = await start("file.bin", 10)
    const noParts = await finish(started, [])
    expect(noParts.headers.get("x-error-code")).toBe("invalid_parts")

    const wrongId = await call(
      new Request(`${ORIGIN}/${started.key}?upload_id=nope&part=1`, { method: "PUT", body: "x", headers: { "content-length": "1" } }),
    )
    expect(wrongId.status).toBeGreaterThanOrEqual(400)

    const notOurs = await call(new Request(`${ORIGIN}/somefile.txt?upload_id=${started.upload_id}&complete`, { method: "POST", body: "{}" }))
    expect(notOurs.headers.get("x-error-code")).toBe("invalid_upload")
  })

  it("never touches an existing file", async () => {
    const plain = await call(new Request(`${ORIGIN}/keep.txt`, { method: "PUT", body: "keep me" }), {})
    const key = new URL((await plain.text()).trim()).pathname.slice(1)
    // A part sent to an existing file's address, with any upload id, is refused.
    const attempt = await call(
      new Request(`${ORIGIN}/${key}?upload_id=made-up&part=1`, { method: "PUT", body: "x", headers: { "content-length": "1" } }),
    )
    expect(attempt.status).toBeGreaterThanOrEqual(400)
    expect(await (await call(new Request(`${ORIGIN}/${key}?raw=1`), {})).text()).toBe("keep me")
  })

  it("tells the page both limits", async () => {
    const page = await (
      await call(new Request(`${ORIGIN}/`, { headers: { "user-agent": "Mozilla/5.0", accept: "text/html" } }))
    ).text()
    expect(page).toContain(`"maxUploadBytes":${12 * MB}`)
    expect(page).toContain(`"maxFileSizeBytes":${6 * MB}`)
    expect(page).toContain(`"partSizeBytes":${5 * MB}`)
  })
})
