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

const TEXT = "; charset=utf-8"
const TYPES_BY_EXTENSION: Record<string, string> = {
  txt: `text/plain${TEXT}`, text: `text/plain${TEXT}`, log: `text/plain${TEXT}`,
  md: `text/markdown${TEXT}`, markdown: `text/markdown${TEXT}`,
  csv: `text/csv${TEXT}`, html: `text/html${TEXT}`, htm: `text/html${TEXT}`, css: `text/css${TEXT}`,
  js: `text/javascript${TEXT}`, mjs: `text/javascript${TEXT}`,
  json: "application/json", xml: "application/xml", yaml: "application/yaml", yml: "application/yaml",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  wasm: "application/wasm", pgp: "application/pgp-encrypted", gpg: "application/pgp-encrypted",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
}

/** Types clients send when they do not actually know the type of what they upload. */
const PLACEHOLDER_TYPES = ["application/octet-stream", "application/x-www-form-urlencoded"]

/**
 * The content type to store for an upload: the one the client sent, unless it
 * sent none or a placeholder (`curl --upload-file` sends none, `curl -d` sends
 * the form type), in which case the file extension decides when it is a known
 * one. A wrong guess is harmless: downloads are sent `nosniff`, and only types
 * that cannot run script are ever shown in place.
 */
export function contentTypeFor(sent: string | null, filename: string): string | undefined {
  const declared = sanitizeContentType(sent)
  const isPlaceholder =
    declared === undefined || PLACEHOLDER_TYPES.includes(declared.split(";")[0].trim().toLowerCase())
  if (!isPlaceholder) return declared
  const extension = /\.([A-Za-z0-9]+)$/.exec(filename)?.[1]?.toLowerCase()
  // hasOwn: a name like "x.constructor" must not pick up a property of Object.
  return extension && Object.hasOwn(TYPES_BY_EXTENSION, extension) ? TYPES_BY_EXTENSION[extension] : declared
}
