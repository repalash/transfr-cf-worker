import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import type { Env } from "../src/env"
import worker from "../src/index"

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
const CURL_UA = "curl/8.4.0"

function bucket(): R2Bucket {
  return env[env.R2_DEFAULT_NAMESPACE] as R2Bucket
}

async function call(request: Request, overrides: Record<string, unknown> = {}): Promise<Response> {
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, { ...env, ...overrides } as Env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

async function upload(
  path: string,
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<{ response: Response; url: string; key: string }> {
  const response = await call(new Request(`https://transfr.test${path}`, { method: "PUT", body, headers }))
  const url = (await response.text()).trim()
  return { response, url, key: url.startsWith("http") ? new URL(url).pathname.slice(1) : "" }
}

beforeEach(async () => {
  for (const object of (await bucket().list()).objects) await bucket().delete(object.key)
})

describe("landing page", () => {
  it("serves the index page at /", async () => {
    const response = await call(new Request("https://transfr.test/", { headers: { "user-agent": BROWSER_UA } }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'")

    const html = await response.text()
    expect(html).toContain("<title>transfr.one</title>")
    // Every template token is filled in.
    expect(html).not.toContain("{{")
    // The page is told the real limits by the worker.
    expect(html).toContain('"maxFileSizeBytes":21000000')
    expect(html).toContain("<code>20 MB</code>")
    expect(html).toContain("<code>24 hours</code>")
    // Docs point at the host being served, not a hard coded one.
    expect(html).toContain("curl --upload-file ./file.txt https://transfr.test")
  })

  it("serves the index page without a body for HEAD /", async () => {
    const response = await call(new Request("https://transfr.test/", { method: "HEAD" }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("")
  })
})

describe("upload", () => {
  it("stores the file and returns its URL", async () => {
    const { response, url } = await upload("/file.txt", "Hello, world!", { "content-type": "text/plain" })
    expect(response.status).toBe(200)
    expect(url).toMatch(/^https:\/\/transfr\.test\/[0-9a-f]{8}-[0-9a-f]{12}\/file\.txt$/)
  })

  it("makes the file readable as soon as the URL is returned", async () => {
    // The PUT response is only sent after the object is committed, so a GET
    // that starts immediately afterwards cannot 404.
    const { key } = await upload("/file.txt", "Hello, world!")
    expect(await bucket().head(key)).not.toBeNull()
  })

  it("accepts POST as well as PUT", async () => {
    const response = await call(new Request("https://transfr.test/file.txt", { method: "POST", body: "data" }))
    expect(response.status).toBe(200)
  })

  it("keeps the sanitised content type", async () => {
    const { key } = await upload("/file.bin", "data", { "content-type": "application/pgp-encrypted" })
    expect((await bucket().head(key))?.httpMetadata?.contentType).toBe("application/pgp-encrypted")
  })

  it("rejects a request without a file name", async () => {
    const response = await call(new Request("https://transfr.test/", { method: "PUT", body: "data" }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("No filename")
  })

  it("rejects a file name that is too long", async () => {
    const response = await call(
      new Request(`https://transfr.test/${"a".repeat(257)}`, { method: "PUT", body: "data" }),
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("Filename too long")
  })

  it("rejects dot and empty path segments", async () => {
    // URL parsing already resolves dot segments (even percent encoded ones),
    // so empty segments are what can actually reach the handler.
    for (const path of ["/a//b.txt", "/dir/"]) {
      const response = await call(new Request(`https://transfr.test${path}`, { method: "PUT", body: "data" }))
      expect(response.status, path).toBe(400)
    }
  })

  it("rejects an empty body", async () => {
    const response = await call(new Request("https://transfr.test/empty.txt", { method: "PUT", body: "" }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("nothing to upload")
  })

  it("rejects a file larger than the limit", async () => {
    const tooBig = "x".repeat(Number(env.R2_MAX_FILE_SIZE_BYTES) + 1)
    const response = await call(new Request("https://transfr.test/big.txt", { method: "PUT", body: tooBig }))
    expect(response.status).toBe(413)
    expect(await response.text()).toMatch(/^Invalid file size/)
  })

  it("rejects an oversized upload from its Content-Length before reading it", async () => {
    const response = await call(
      new Request("https://transfr.test/big.txt", {
        method: "PUT",
        body: "small",
        headers: { "content-length": "99999999" },
      }),
    )
    expect(response.status).toBe(413)
  })
})

describe("download", () => {
  it("returns the stored bytes to a non browser client", async () => {
    const { url } = await upload("/file.txt", "Hello, world!", { "content-type": "text/plain" })
    const response = await call(new Request(url, { headers: { "user-agent": CURL_UA } }))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("Hello, world!")
    expect(response.headers.get("content-type")).toBe("text/plain")
    expect(response.headers.get("content-length")).toBe("13")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("accept-ranges")).toBe("bytes")
    expect(response.headers.get("etag")).toBeTruthy()
    expect(response.headers.get("cache-control")).toMatch(/^private, max-age=\d+, immutable$/)
  })

  it("serves the bytes to a browser when ?raw is set", async () => {
    const { url } = await upload("/file.txt", "raw bytes")
    const response = await call(new Request(`${url}?raw=1`, { headers: { "user-agent": BROWSER_UA } }))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("raw bytes")
  })

  it("never renders uploaded HTML in place", async () => {
    const { url } = await upload("/page.html", "<script>alert(1)</script>", { "content-type": "text/html" })
    const response = await call(new Request(`${url}?raw=1`, { headers: { "user-agent": BROWSER_UA } }))
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="page.html"/)
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
  })

  it("lets images be displayed inline", async () => {
    const { url } = await upload("/pic.png", "not really a png", { "content-type": "image/png" })
    const response = await call(new Request(url, { headers: { "user-agent": CURL_UA } }))
    expect(response.headers.get("content-disposition")).toMatch(/^inline; filename="pic.png"/)
  })

  it("falls back to application/octet-stream for a bogus content type", async () => {
    const { url } = await upload("/file.bin", "data", { "content-type": "definitely not a media type" })
    const response = await call(new Request(url, { headers: { "user-agent": CURL_UA } }))
    expect(response.headers.get("content-type")).toBe("application/octet-stream")
  })

  it("answers HEAD with the metadata and no body", async () => {
    const { url } = await upload("/file.txt", "Hello, world!")
    const response = await call(new Request(url, { method: "HEAD", headers: { "user-agent": CURL_UA } }))
    expect(response.status).toBe(200)
    expect(response.headers.get("content-length")).toBe("13")
    expect(await response.text()).toBe("")
  })

  it("serves byte ranges", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    const response = await call(new Request(url, { headers: { range: "bytes=2-5", "user-agent": CURL_UA } }))
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(response.headers.get("content-length")).toBe("4")
    expect(await response.text()).toBe("2345")
  })

  it("serves a suffix range", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    const response = await call(new Request(url, { headers: { range: "bytes=-3", "user-agent": CURL_UA } }))
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 7-9/10")
    expect(await response.text()).toBe("789")
  })

  it("answers a matching If-None-Match with 304", async () => {
    const { url } = await upload("/file.txt", "Hello, world!")
    const first = await call(new Request(url, { headers: { "user-agent": CURL_UA } }))
    const etag = first.headers.get("etag")!

    const second = await call(
      new Request(url, { headers: { "user-agent": CURL_UA, "if-none-match": etag } }),
    )
    expect(second.status).toBe(304)
    expect(await second.text()).toBe("")
  })

  it("404s for an unknown key", async () => {
    const response = await call(
      new Request("https://transfr.test/68d0f3a2-3f1c9b27d4e0/nope.txt", { headers: { "user-agent": CURL_UA } }),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Not Found\n")
  })

  it("refuses to serve an expired key and deletes the object", async () => {
    const expired = `${(Math.floor(Date.now() / 1000) - 10).toString(16)}-abcdef012345/old.txt`
    await bucket().put(expired, "stale")

    const response = await call(
      new Request(`https://transfr.test/${expired}`, { headers: { "user-agent": CURL_UA } }),
    )
    expect(response.status).toBe(404)
    expect(await bucket().head(expired)).toBeNull()
  })
})

describe("access page", () => {
  it("is served to browsers instead of the bytes", async () => {
    const { url } = await upload("/notes.txt", "Hello, world!", { "content-type": "text/plain" })
    const response = await call(new Request(url, { headers: { "user-agent": BROWSER_UA } }))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const html = await response.text()
    expect(html).not.toContain("{{")
    expect(html).toContain("notes.txt")
    expect(html).toContain("13 bytes")
    expect(html).toContain(`${url}?raw=1`)
    expect(html).toContain(".if_encrypted {\n          display: none;")
  })

  it("offers decryption for a .pgp file", async () => {
    const { url } = await upload("/secret.txt.pgp", "encrypted bytes")
    const html = await call(new Request(url, { headers: { "user-agent": BROWSER_UA } })).then((r) => r.text())
    expect(html).toContain(".if_encrypted {\n          display: block;")
    expect(html).toContain('"encrypted":true')
    expect(html).toContain('"decryptedName":"secret.txt"')
  })

  it("escapes the file name instead of injecting it into the page", async () => {
    const nasty = `"><img src=x onerror=alert(1)>.txt`
    const { url } = await upload(`/${encodeURIComponent(nasty)}`, "data")
    const html = await call(new Request(url, { headers: { "user-agent": BROWSER_UA } })).then((r) => r.text())

    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    // Inside the JSON block, markup characters are unicode escaped.
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)\\u003e')
  })

  it("404s for a browser hitting a missing file", async () => {
    const response = await call(
      new Request("https://transfr.test/68d0f3a2-3f1c9b27d4e0/nope.txt", { headers: { "user-agent": BROWSER_UA } }),
    )
    expect(response.status).toBe(404)
  })

  it("is skipped for hosts listed in RAW_ONLY_HOSTS", async () => {
    const { key } = await upload("/file.txt", "Hello, world!")
    const response = await call(
      new Request(`https://bee.transfr.test/${key}`, { headers: { "user-agent": BROWSER_UA } }),
      { RAW_ONLY_HOSTS: "bee.transfr.test" },
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("Hello, world!")
  })
})

describe("protocol", () => {
  it("answers a CORS preflight", async () => {
    const response = await call(
      new Request("https://transfr.test/file.txt", {
        method: "OPTIONS",
        headers: {
          origin: "https://example.com",
          "access-control-request-method": "PUT",
          "access-control-request-headers": "content-type",
        },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type")
  })

  it("advertises only the methods it implements", async () => {
    const response = await call(new Request("https://transfr.test/file.txt", { method: "OPTIONS" }))
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST, PUT, OPTIONS")
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, POST, PUT, OPTIONS")
  })

  it("rejects an unsupported method with 405", async () => {
    const response = await call(new Request("https://transfr.test/file.txt", { method: "DELETE" }))
    expect(response.status).toBe(405)
    expect(response.headers.get("allow")).toBe("GET, HEAD, POST, PUT, OPTIONS")
  })
})

describe("configuration", () => {
  it("fails loudly instead of ignoring an invalid size limit", async () => {
    const response = await call(new Request("https://transfr.test/file.txt", { method: "PUT", body: "data" }), {
      R2_MAX_FILE_SIZE_BYTES: "twenty megabytes",
    })
    expect(response.status).toBe(500)
    expect(await response.text()).toBe("Server misconfigured\n")
  })

  it("fails when no bucket is bound", async () => {
    const response = await call(new Request("https://transfr.test/file.txt"), {
      R2_DEFAULT_NAMESPACE: "MISSING_BUCKET",
    })
    expect(response.status).toBe(500)
  })
})
