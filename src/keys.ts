/**
 * Object keys look like `<expiry-hex>-<random-hex>/<file name>`.
 *
 * The expiry is part of the key so that the worker can refuse to serve a file
 * whose lifetime has passed, without depending on the R2 lifecycle rule (which
 * only has day granularity) having already removed the object.
 */

/** Bytes of randomness in a key. The key is the only secret protecting a file. */
const RANDOM_BYTES = 6

const KEY_PREFIX_RE = /^([0-9a-f]{1,12})-([0-9a-f]{1,32})(?:\/|$)/

export interface ObjectKey {
  key: string
  /** Unix timestamp (seconds) after which the file must no longer be served. */
  expiresAt: number
}

export function createObjectKey(filename: string, ttlSeconds: number, now: number = Date.now()): ObjectKey {
  const expiresAt = Math.floor(now / 1000) + ttlSeconds
  return { key: `${expiresAt.toString(16)}-${randomHex(RANDOM_BYTES)}/${filename}`, expiresAt }
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Expiry encoded in the key, or `null` for keys that do not carry one. */
export function parseExpiry(key: string): number | null {
  const match = KEY_PREFIX_RE.exec(key)
  if (!match) return null
  const expiresAt = Number.parseInt(match[1], 16)
  return Number.isSafeInteger(expiresAt) ? expiresAt : null
}

export function isExpired(key: string, now: number = Date.now()): boolean {
  const expiresAt = parseExpiry(key)
  return expiresAt !== null && expiresAt * 1000 <= now
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
