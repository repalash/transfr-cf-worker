/**
 * Object keys look like `<random-hex>-<expiry-hex>/<file name>`.
 *
 * The expiry is part of the key so that the worker can refuse to serve a file
 * whose lifetime has passed, without depending on the R2 lifecycle rule (which
 * only has day granularity) having already removed the object.
 *
 * Two older layouts are still out there in links people hold:
 * - `<1-4 random hex>-<expiry hex>/<name>`: the first KV version.
 * - `<expiry hex>-<1-4 random hex>/<name>`: the R2 worker that ran until
 *   November 2026. It never enforced the expiry; its files lived until the
 *   bucket's lifecycle rule removed them, and that is still how they are
 *   treated, so links people were given keep working as they did.
 *
 * An expiry is a Unix time in seconds, which is 8 hex digits for any date
 * this worker will see, while the random part is 1-4 digits (old) or 12
 * (now). So the part with 8 digits is the expiry, whichever side it is on.
 */


const KEY_PREFIX_RE = /^([0-9a-f]{1,32})-([0-9a-f]{1,12})(?:\/|$)/

export interface ObjectKey {
  key: string
  /** Unix timestamp (seconds) after which the file must no longer be served. */
  expiresAt: number
}

/**
 * A new key in the layout links have always had on the live site:
 * `<expiry hex>-<1-2 random hex>/<name>`, e.g. `6af77f4d-a2/model.glb`.
 */
export function createObjectKey(filename: string, ttlSeconds: number, now: number = Date.now()): ObjectKey {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds
  const random = crypto.getRandomValues(new Uint8Array(1))[0] ?? 0
  return { key: `${expiresAt.toString(16)}-${random.toString(16)}/${filename}`, expiresAt }
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return toHex(buffer)
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

const EXPIRY_DIGITS = 8

/** Where a key keeps its expiry, or null for keys that carry none. */
function expiryOf(key: string): { expiresAt: number; enforced: boolean } | null {
  const match = KEY_PREFIX_RE.exec(key)
  if (!match) return null
  const [, first = "", second = ""] = match
  if (second.length === EXPIRY_DIGITS) return { expiresAt: Number.parseInt(second, 16), enforced: true }
  // The R2 worker before November 2026 put the expiry first and never enforced it.
  if (first.length === EXPIRY_DIGITS && second.length <= 4) {
    return { expiresAt: Number.parseInt(first, 16), enforced: false }
  }
  return null
}

/** Expiry encoded in the key, or `null` for keys that do not carry one. */
export function parseExpiry(key: string): number | null {
  return expiryOf(key)?.expiresAt ?? null
}

/** Whether the file must no longer be served (and can be deleted). */
export function isExpired(key: string, now: number = Date.now()): boolean {
  const expiry = expiryOf(key)
  return expiry !== null && expiry.enforced && expiry.expiresAt * 1000 <= now
}

/** The file name part of a key (everything after the random prefix). */
export function filenameFromKey(key: string): string {
  const slash = key.indexOf("/")
  return slash === -1 ? key : key.slice(slash + 1)
}

/** File names travel through the URL path, so they reach us percent encoded. */
export function decodeFilename(filename: string): string {
  try {
    return decodeURIComponent(filename)
  } catch {
    return filename // malformed escape sequence: show it as-is
  }
}
