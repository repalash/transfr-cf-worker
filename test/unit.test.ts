import { describe, expect, it } from "vitest"
import { escapeHtml, jsonForScript } from "../src/escape"
import { formatBytes, formatDuration, formatRelativeTo } from "../src/format"
import { createObjectKey, decodeFilename, filenameFromKey, isExpired, parseExpiry } from "../src/keys"
import { contentDisposition, isInlineSafe, sanitizeContentType } from "../src/mime"
import { render } from "../src/templates"

describe("keys", () => {
  it("encodes the expiry and enough randomness in the key", () => {
    const now = 1_700_000_000_000
    const { key, expiresAt } = createObjectKey("file.txt", 86_400, now)
    expect(expiresAt).toBe(1_700_000_000 + 86_400)
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{12}\/file\.txt$/)
    expect(parseExpiry(key)).toBe(expiresAt)
  })

  it("does not repeat keys", () => {
    const keys = new Set(Array.from({ length: 200 }, () => createObjectKey("f", 60).key))
    expect(keys.size).toBe(200)
  })

  it("treats a key as expired once its timestamp has passed", () => {
    const now = 1_700_000_000_000
    const { key } = createObjectKey("file.txt", 60, now)
    expect(isExpired(key, now)).toBe(false)
    expect(isExpired(key, now + 59_000)).toBe(false)
    expect(isExpired(key, now + 61_000)).toBe(true)
  })

  it("leaves keys without an expiry prefix alone", () => {
    expect(parseExpiry("not-a-key/file.txt")).toBeNull()
    expect(isExpired("not-a-key/file.txt")).toBe(false)
    expect(parseExpiry("file.txt")).toBeNull()
  })

  it("extracts and decodes the file name", () => {
    expect(filenameFromKey("68d0f3a2-3f1c9b27d4e0/dir/file.txt")).toBe("dir/file.txt")
    expect(filenameFromKey("file.txt")).toBe("file.txt")
    expect(decodeFilename("my%20file.txt")).toBe("my file.txt")
    expect(decodeFilename("100%.txt")).toBe("100%.txt")
  })
})

describe("escape", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    )
    expect(escapeHtml("a & b's")).toBe("a &amp; b&#39;s")
  })

  it("keeps JSON payloads from escaping their script block", () => {
    const json = jsonForScript({ name: "</script><script>alert(1)</script>" })
    expect(json).not.toContain("<")
    expect(json).not.toContain(">")
    expect(JSON.parse(json).name).toBe("</script><script>alert(1)</script>")
  })
})

describe("render", () => {
  it("substitutes tokens in a single pass", () => {
    expect(render("{{A}}/{{B}}", { A: "1", B: "2" })).toBe("1/2")
    // A value that looks like a token is not substituted again.
    expect(render("{{A}} {{B}}", { A: "{{B}}", B: "boom" })).toBe("{{B}} boom")
  })

  it("leaves unknown tokens untouched", () => {
    expect(render("{{A}}", {})).toBe("{{A}}")
  })
})

describe("mime", () => {
  it("accepts well formed media types only", () => {
    expect(sanitizeContentType("text/plain")).toBe("text/plain")
    expect(sanitizeContentType("text/plain; charset=utf-8")).toBe("text/plain; charset=utf-8")
    expect(sanitizeContentType('multipart/form-data; boundary="ab-cd"')).toBe('multipart/form-data; boundary="ab-cd"')
    expect(sanitizeContentType(null)).toBeUndefined()
    expect(sanitizeContentType("not a type")).toBeUndefined()
    expect(sanitizeContentType("text/html\r\nX-Evil: 1")).toBeUndefined()
    expect(sanitizeContentType(`text/plain; charset="${"a".repeat(300)}"`)).toBeUndefined()
  })

  it("only renders non-scriptable types inline", () => {
    expect(isInlineSafe("image/png")).toBe(true)
    expect(isInlineSafe("text/plain; charset=utf-8")).toBe(true)
    expect(isInlineSafe("video/mp4")).toBe(true)
    expect(isInlineSafe("image/svg+xml")).toBe(false)
    expect(isInlineSafe("text/html")).toBe(false)
    expect(isInlineSafe("application/pdf")).toBe(false)
    expect(isInlineSafe("application/octet-stream")).toBe(false)
  })

  it("builds a safe Content-Disposition", () => {
    expect(contentDisposition("file.txt", "text/html")).toBe(
      `attachment; filename="file.txt"; filename*=UTF-8''file.txt`,
    )
    expect(contentDisposition("nötes.png", "image/png")).toBe(
      `inline; filename="n_tes.png"; filename*=UTF-8''n%C3%B6tes.png`,
    )
    // Quotes cannot break out of the ASCII fallback.
    expect(contentDisposition('a";x="y', "text/html")).toBe(
      `attachment; filename="a_;x=_y"; filename*=UTF-8''a%22%3Bx%3D%22y`,
    )
  })
})

describe("format", () => {
  it("formats sizes", () => {
    expect(formatBytes(1)).toBe("1 byte")
    expect(formatBytes(999)).toBe("999 bytes")
    expect(formatBytes(2048)).toBe("2.0 KB")
    expect(formatBytes(21_000_000)).toBe("20 MB")
  })

  it("formats durations", () => {
    expect(formatDuration(30)).toBe("30 seconds")
    expect(formatDuration(600)).toBe("10 minutes")
    expect(formatDuration(86_400)).toBe("24 hours")
    expect(formatDuration(7 * 86_400)).toBe("7 days")
  })

  it("formats time remaining", () => {
    const now = 1_700_000_000_000
    expect(formatRelativeTo(1_700_000_000 + 3_600, now)).toBe("in 1 hour")
    expect(formatRelativeTo(1_700_000_000 - 1, now)).toBe("now")
  })
})
