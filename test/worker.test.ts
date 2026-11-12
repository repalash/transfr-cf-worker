import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import type { Env } from "../src/env"
import worker from "../src/index"

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
const CURL_UA = "curl/8.4.0"
/** What a browser sends when the link is opened in a tab. */
const NAVIGATION = {
  "user-agent": BROWSER_UA,
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

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

/** A body with no known length, as a chunked upload arrives. */
function chunked(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
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
    // Indexable, unlike the file pages.
    expect(response.headers.get("x-robots-tag")).toBeNull()

    const html = await response.text()
    expect(html).toContain("<title>transfr.one</title>")
    // Scripts, styles and fonts come from this origin only, and none inline.
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self';")
    expect(html).not.toMatch(/<(script|link)[^>]*(src|href)="https?:/)
    expect(html).not.toMatch(/<script(?![^>]*(\ssrc=|type="application\/json"))/)
    // Every template token is filled in.
    expect(html).not.toContain("{{")
    // The page is told the real limits by the worker.
    expect(html).toContain('"maxFileSizeBytes":100000000')
    expect(html).toContain("<code>95 MB</code>")
    expect(html).toContain("<code>20 MB</code> for a streamed upload without a")
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
    expect(url).toMatch(/^https:\/\/transfr\.test\/[0-9a-f]{12}-[0-9a-f]{8}\/file\.txt$/)
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

  it("counts a non-ASCII file name in characters, not in its encoded length", async () => {
    // 30 characters, but 274 once percent encoded.
    const name = `${"日".repeat(30)}.txt`
    const { response, key } = await upload(`/${encodeURIComponent(name)}`, "data")
    expect(response.status).toBe(200)
    expect(await (await bucket().get(key))?.text()).toBe("data")

    const tooManyCharacters = await upload(`/${encodeURIComponent("日".repeat(257))}`, "data")
    expect(tooManyCharacters.response.status).toBe(400)
  })

  it("rejects a name whose encoded form would not fit in an object key", async () => {
    // 120 characters is fine decoded, but 1080 encoded.
    const { response, url } = await upload(`/${encodeURIComponent("日".repeat(120))}`, "data")
    expect(response.status).toBe(400)
    expect(url).toContain("Filename too long")
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
    const response = await call(
      new Request("https://transfr.test/big.txt", { method: "PUT", body: "x".repeat(11) }),
      { R2_MAX_FILE_SIZE_BYTES: "10" },
    )
    expect(response.status).toBe(413)
    expect(await response.text()).toMatch(/^Invalid file size/)
  })

  it("rejects an oversized upload from its Content-Length before reading it", async () => {
    const response = await call(
      new Request("https://transfr.test/big.txt", {
        method: "PUT",
        body: "small",
        headers: { "content-length": "11" },
      }),
      { R2_MAX_FILE_SIZE_BYTES: "10" },
    )
    expect(response.status).toBe(413)
    expect(await response.text()).toBe("Invalid file size: 11, max size = 10\n")
  })

  it("streams an upload with a Content-Length past the buffered limit", async () => {
    const data = "0123456789".repeat(5)
    const response = await call(
      new Request("https://transfr.test/streamed.txt", {
        method: "PUT",
        body: data,
        headers: { "content-length": String(data.length) },
      }),
      { R2_MAX_FILE_SIZE_BYTES: "100", R2_MAX_BUFFERED_FILE_SIZE_BYTES: "10" },
    )
    expect(response.status).toBe(200)
    const key = new URL((await response.text()).trim()).pathname.slice(1)
    expect(await (await bucket().get(key))?.text()).toBe(data)
  })

  it("rejects a body that does not match its Content-Length, storing nothing", async () => {
    for (const length of ["10", "3"]) {
      const response = await call(
        new Request("https://transfr.test/short.txt", {
          method: "PUT",
          body: "small",
          headers: { "content-length": length },
        }),
      )
      expect(response.status, length).toBe(400)
      expect(await response.text()).toMatch(/^Upload incomplete/)
    }
    expect((await bucket().list()).objects).toHaveLength(0)
  })

  it("rejects an empty body declared with a Content-Length of 0", async () => {
    const response = await call(
      new Request("https://transfr.test/empty.txt", { method: "PUT", body: "", headers: { "content-length": "0" } }),
    )
    expect(response.status).toBe(400)
  })

  it("buffers an upload without a Content-Length under the lower limit", async () => {
    const response = await call(
      new Request("https://transfr.test/chunked.txt", { method: "PUT", body: chunked("abc", "def") }),
      { R2_MAX_BUFFERED_FILE_SIZE_BYTES: "10" },
    )
    expect(response.status).toBe(200)
    const key = new URL((await response.text()).trim()).pathname.slice(1)
    expect(await (await bucket().get(key))?.text()).toBe("abcdef")
  })

  it("rejects an upload without a Content-Length past the buffered limit", async () => {
    const response = await call(
      new Request("https://transfr.test/chunked.txt", { method: "PUT", body: chunked("012345", "6789ab") }),
      { R2_MAX_FILE_SIZE_BYTES: "100", R2_MAX_BUFFERED_FILE_SIZE_BYTES: "10" },
    )
    expect(response.status).toBe(413)
    const text = await response.text()
    expect(text).toMatch(/^Invalid file size: more than 10/)
    expect(text).toContain("Content-Length header")
    expect(text).toContain("up to 100")
    expect((await bucket().list()).objects).toHaveLength(0)
  })

  it("stores the file from a multipart form, not the form itself", async () => {
    const form = new FormData()
    form.append("note", "ignored text field")
    form.append("file", new File(["Hello, form!"], "local-name.txt", { type: "text/plain" }))
    const { response, url, key } = await upload("/form.txt", form)

    expect(response.status).toBe(200)
    expect(url).toMatch(/\/form\.txt$/)
    const stored = await bucket().get(key)
    expect(await stored?.text()).toBe("Hello, form!")
    expect(stored?.httpMetadata?.contentType).toBe("text/plain")
  })

  it("names a form upload after its file when the URL has no name", async () => {
    const form = new FormData()
    form.append("file", new File(["data"], "my report.txt"))
    const { response, url } = await upload("/", form)
    expect(response.status).toBe(200)
    expect(url).toMatch(/\/my%20report\.txt$/)
  })

  it("rejects a form without a file, and a form that is too large", async () => {
    const empty = new FormData()
    empty.append("note", "just text")
    const noFile = await upload("/form.txt", empty)
    expect(noFile.response.status).toBe(400)
    expect(noFile.url).toContain("No file in the form")

    const big = new FormData()
    big.append("file", new File(["x".repeat(200)], "big.txt"))
    const response = await call(new Request("https://transfr.test/big.txt", { method: "POST", body: big }), {
      R2_MAX_BUFFERED_FILE_SIZE_BYTES: "100",
    })
    expect(response.status).toBe(413)
    expect(await response.text()).toContain("curl --upload-file")
    expect((await bucket().list()).objects).toHaveLength(0)
  })

  it("never buffers more than the overall limit", async () => {
    const response = await call(
      new Request("https://transfr.test/chunked.txt", { method: "PUT", body: chunked("012345", "6789ab") }),
      { R2_MAX_FILE_SIZE_BYTES: "10", R2_MAX_BUFFERED_FILE_SIZE_BYTES: "1000" },
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
    expect(response.headers.get("content-security-policy")).toMatch(/^default-src 'none'; .*sandbox$/)
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

  it("answers a range from the first byte with 206", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    const response = await call(new Request(url, { headers: { range: "bytes=0-", "user-agent": CURL_UA } }))
    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 0-9/10")
    expect(await response.text()).toBe("0123456789")
  })

  it("answers a range past the end of the file with 416", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    const response = await call(new Request(url, { headers: { range: "bytes=10-", "user-agent": CURL_UA } }))
    expect(response.status).toBe(416)
    expect(response.headers.get("content-range")).toBe("bytes */10")
  })

  it("clamps a range that runs past the end of the file", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    for (const [range, contentRange, body] of [
      ["bytes=8-100", "bytes 8-9/10", "89"],
      ["bytes=-100", "bytes 0-9/10", "0123456789"],
    ]) {
      const response = await call(new Request(url, { headers: { range, "user-agent": CURL_UA } }))
      expect(response.status, range).toBe(206)
      expect(response.headers.get("content-range"), range).toBe(contentRange)
      expect(await response.text(), range).toBe(body)
    }
  })

  it("ignores a Range header it does not understand and sends the whole file", async () => {
    const { url } = await upload("/file.txt", "0123456789")
    for (const range of ["bytes=abc", "bytes=0-1,4-5", "bytes=5-2", "lines=1-2", "bytes=-"]) {
      const response = await call(new Request(url, { headers: { range, "user-agent": CURL_UA } }))
      expect(response.status, range).toBe(200)
      expect(await response.text(), range).toBe("0123456789")
    }
  })

  it("keeps files out of search engines and lets the browser's own viewers show media", async () => {
    const { url } = await upload("/clip.mp4", "not really a video", { "content-type": "video/mp4" })
    const response = await call(new Request(url, { headers: { "user-agent": CURL_UA } }))
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/)
    const csp = response.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("media-src 'self'")
    expect(csp).toContain("sandbox")
    expect(csp).not.toContain("script-src")
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
      new Request("https://transfr.test/3f1c9b27d4e0-ffffffff/nope.txt", { headers: { "user-agent": CURL_UA } }),
    )
    expect(response.status).toBe(404)
    expect(await response.text()).toBe("Not Found\n")
  })

  it("refuses to serve an expired key and deletes the object", async () => {
    const expired = `abcdef012345-${(Math.floor(Date.now() / 1000) - 10).toString(16)}/old.txt`
    await bucket().put(expired, "stale")

    const response = await call(
      new Request(`https://transfr.test/${expired}`, { headers: { "user-agent": CURL_UA } }),
    )
    expect(response.status).toBe(404)
    expect(await bucket().head(expired)).toBeNull()
  })

  it("still serves a link made by an earlier version until it expires", async () => {
    // Earlier versions put one to four random digits before the expiry.
    const legacy = `22e3-${(Math.floor(Date.now() / 1000) + 3600).toString(16)}/old.txt`
    await bucket().put(legacy, "still here")

    const response = await call(
      new Request(`https://transfr.test/${legacy}`, { headers: { "user-agent": CURL_UA } }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("still here")
    expect(await bucket().head(legacy)).not.toBeNull()
  })
})

describe("access page", () => {
  it("is served to a browser opening the link instead of the bytes", async () => {
    const { url } = await upload("/notes.txt", "Hello, world!", { "content-type": "text/plain" })
    const response = await call(new Request(url, { headers: NAVIGATION }))

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
    const html = await call(new Request(url, { headers: NAVIGATION })).then((r) => r.text())
    expect(html).toContain(".if_encrypted {\n          display: block;")
    expect(html).toContain('"encrypted":true')
    expect(html).toContain('"decryptedName":"secret.txt"')
  })

  it("escapes the file name instead of injecting it into the page", async () => {
    const nasty = `"><img src=x onerror=alert(1)>.txt`
    const { url } = await upload(`/${encodeURIComponent(nasty)}`, "data")
    const html = await call(new Request(url, { headers: NAVIGATION })).then((r) => r.text())

    expect(html).not.toContain("<img src=x")
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    // Inside the JSON block, markup characters are unicode escaped.
    expect(html).toContain('\\u003cimg src=x onerror=alert(1)\\u003e')
  })

  it("is not indexed and varies on what the request is for", async () => {
    const { url } = await upload("/notes.txt", "Hello, world!")
    const response = await call(new Request(url, { headers: NAVIGATION }))
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    expect(response.headers.get("vary")).toBe("Sec-Fetch-Dest, Accept")
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self';")
  })

  it("gives fetch(), <img> and <video> in a browser the bytes, not the page", async () => {
    const { url } = await upload("/notes.txt", "Hello, world!", { "content-type": "text/plain" })
    for (const destination of ["empty", "image", "video", "audio", "iframe"]) {
      const response = await call(
        new Request(url, { headers: { "user-agent": BROWSER_UA, "sec-fetch-dest": destination, accept: "*/*" } }),
      )
      expect(await response.text(), destination).toBe("Hello, world!")
    }
  })

  it("falls back to the Accept header for clients that send no Sec-Fetch-Dest", async () => {
    const { url } = await upload("/notes.txt", "Hello, world!", { "content-type": "text/plain" })
    const page = await call(new Request(url, { headers: { "user-agent": BROWSER_UA, accept: "text/html,*/*;q=0.8" } }))
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    // A browser-like User-Agent alone no longer gets the page.
    const bytes = await call(new Request(url, { headers: { "user-agent": BROWSER_UA, accept: "*/*" } }))
    expect(await bytes.text()).toBe("Hello, world!")
  })

  it("quotes the uploader's file name and link in the commands it shows", async () => {
    const { url } = await upload("/a;id;$(whoami)'x.txt", "data")
    const html = await call(new Request(url, { headers: NAVIGATION })).then((r) => r.text())

    // In single quotes the shell interprets nothing; a quote in the value is
    // closed, escaped and reopened. All of it is HTML escaped on the page.
    const Q = "&#39;"
    const quotedName = `${Q}a;id;$(whoami)${Q}\\${Q}${Q}x.txt${Q}`
    const quotedUrl = `${Q}${url.replace("'", `${Q}\\${Q}${Q}`)}${Q}`
    expect(html).toContain(`curl -L ${quotedUrl} -o ${quotedName}`)
    // The code snippets get a double quoted string literal.
    expect(html).toContain(`&quot;${url.replace("'", Q)}&quot;`)
    // Nowhere does the raw name follow a command unquoted.
    expect(html).not.toContain("-o a;id")
    expect(html).not.toContain(`curl -L ${url.split("'")[0]}`)
  })

  it("leaves an ordinary file name and link unquoted in the commands", async () => {
    const { url } = await upload("/notes.txt", "data")
    const html = await call(new Request(url, { headers: NAVIGATION })).then((r) => r.text())
    expect(html).toContain(`curl -L ${url} -o notes.txt`)
  })

  it("saves to the file name only, never to a path from the link", async () => {
    const { url } = await upload("/some/dir/notes.txt", "data")
    const html = await call(new Request(url, { headers: NAVIGATION })).then((r) => r.text())
    expect(html).toContain(`curl -L ${url} -o notes.txt`)
  })

  it("404s for a browser hitting a missing file", async () => {
    const response = await call(
      new Request("https://transfr.test/3f1c9b27d4e0-ffffffff/nope.txt", { headers: NAVIGATION }),
    )
    expect(response.status).toBe(404)
  })

  it("is skipped for hosts listed in RAW_ONLY_HOSTS", async () => {
    const { key } = await upload("/file.txt", "Hello, world!")
    const response = await call(
      new Request(`https://bee.transfr.test/${key}`, { headers: NAVIGATION }),
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

  it("fails loudly on an invalid buffered size limit too", async () => {
    const response = await call(new Request("https://transfr.test/file.txt", { method: "PUT", body: "data" }), {
      R2_MAX_BUFFERED_FILE_SIZE_BYTES: "-1",
    })
    expect(response.status).toBe(500)
  })

  it("fails when no bucket is bound", async () => {
    const response = await call(new Request("https://transfr.test/file.txt"), {
      R2_DEFAULT_NAMESPACE: "MISSING_BUCKET",
    })
    expect(response.status).toBe(500)
  })
})
