/** `type/subtype` with optional parameters, per RFC 9110 token rules. */
const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+"
const CONTENT_TYPE_RE = new RegExp(`^${TOKEN}/${TOKEN}(\\s*;\\s*${TOKEN}=("[^"\\\\]*"|${TOKEN}))*$`)

/**
 * Content types are attacker supplied and echoed back on download, so anything
 * that is not a well formed media type is dropped (R2 then serves the object as
 * `application/octet-stream`).
 */
export function sanitizeContentType(value: string | null): string | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  if (trimmed.length > 255 || !CONTENT_TYPE_RE.test(trimmed)) return undefined
  return trimmed
}

/**
 * Types the browser may render in place. Everything else — HTML, SVG, PDF,
 * anything unknown — is sent as an attachment, so an upload can never run
 * script on this origin.
 */
export function isInlineSafe(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase()
  if (type === "text/plain") return true
  if (type.startsWith("image/")) return type !== "image/svg+xml"
  return type.startsWith("video/") || type.startsWith("audio/")
}

/**
 * Builds a `Content-Disposition` value with both the ASCII fallback and the
 * RFC 5987 encoded form, from an untrusted file name.
 */
export function contentDisposition(filename: string, contentType: string): string {
  const name = filename.split("/").pop() || "download"
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  const disposition = isInlineSafe(contentType) ? "inline" : "attachment"
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRfc5987(name)}`
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}
