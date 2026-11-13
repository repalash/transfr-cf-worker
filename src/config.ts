import type { Env } from "./env"

/** Longest accepted file name for an upload, in characters once decoded. */
export const MAX_FILENAME_LENGTH = 256
/**
 * Longest accepted file name as it travels in the URL, percent encoded. A
 * non-ASCII character takes up to twelve characters there, and the encoded name
 * is part of the object key, which R2 limits to 1024 bytes.
 */
export const MAX_ENCODED_FILENAME_LENGTH = 960

const DEFAULT_MAX_FILE_SIZE_BYTES = 21_000_000 // 20 MB
/**
 * An upload without a Content-Length has to be read into memory to learn its
 * size before R2 will take it, so it gets a lower limit: a Worker has 128 MB.
 */
const DEFAULT_MAX_BUFFERED_FILE_SIZE_BYTES = 21_000_000 // 20 MB
const DEFAULT_FILE_TTL_SECONDS = 86_400 // 24 hours
const DEFAULT_PIPE_WAIT_SECONDS = 300 // 5 minutes
const DEFAULT_STREAM_MAX_BYTES = 1_000_000_000 // 1 GB
const DEFAULT_STREAM_IDLE_TTL_SECONDS = 86_400 // 24 hours after the last write
const DEFAULT_STREAM_MAX_TTL_SECONDS = 604_800 // 7 days after creation
const DEFAULT_STREAM_FOLLOW_SECONDS = 3_600 // 1 hour

export interface Config {
  bucket: R2Bucket
  /** Largest upload with a Content-Length; streamed straight to R2. */
  maxFileSizeBytes: number
  /** Largest upload without a Content-Length; buffered in memory. Never above maxFileSizeBytes. */
  maxBufferedFileSizeBytes: number
  fileTtlSeconds: number
  rawOnlyHosts: string[]
  /** Origin to point search engines and share previews at, or null to use the request's own. */
  canonicalOrigin: string | null
  /** How long one side of a pipe waits for the other. */
  pipeWaitSeconds: number
  /** Largest a stream may grow. */
  streamMaxBytes: number
  /** A stream is deleted this long after its last write... */
  streamIdleTtlSeconds: number
  /** ...and this long after its creation at the latest. */
  streamMaxTtlSeconds: number
  /** How long a `?follow` connection is kept open. */
  streamFollowSeconds: number
}

/** Thrown when the worker is misconfigured; surfaced as a 500, never as a 404. */
export class ConfigError extends Error {
  override readonly name = "ConfigError"
}

export function loadConfig(env: Env): Config {
  const bindingName = env.R2_DEFAULT_NAMESPACE
  if (!bindingName) throw new ConfigError("R2_DEFAULT_NAMESPACE is not set")

  const bucket = env[bindingName] as R2Bucket | undefined
  if (!bucket || typeof bucket.get !== "function") {
    throw new ConfigError(`No R2 bucket bound as "${bindingName}"`)
  }

  const maxFileSizeBytes = positiveInt(env.R2_MAX_FILE_SIZE_BYTES, "R2_MAX_FILE_SIZE_BYTES", DEFAULT_MAX_FILE_SIZE_BYTES)
  const maxBufferedFileSizeBytes = positiveInt(
    env.R2_MAX_BUFFERED_FILE_SIZE_BYTES,
    "R2_MAX_BUFFERED_FILE_SIZE_BYTES",
    DEFAULT_MAX_BUFFERED_FILE_SIZE_BYTES,
  )

  return {
    bucket,
    maxFileSizeBytes,
    maxBufferedFileSizeBytes: Math.min(maxBufferedFileSizeBytes, maxFileSizeBytes),
    fileTtlSeconds: positiveInt(env.R2_DEFAULT_FILE_TTL, "R2_DEFAULT_FILE_TTL", DEFAULT_FILE_TTL_SECONDS),
    rawOnlyHosts: (env.RAW_ONLY_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
    canonicalOrigin: origin(env.CANONICAL_ORIGIN, "CANONICAL_ORIGIN"),
    pipeWaitSeconds: positiveInt(env.PIPE_WAIT_SECONDS, "PIPE_WAIT_SECONDS", DEFAULT_PIPE_WAIT_SECONDS),
    streamMaxBytes: positiveInt(env.STREAM_MAX_BYTES, "STREAM_MAX_BYTES", DEFAULT_STREAM_MAX_BYTES),
    streamIdleTtlSeconds: positiveInt(env.STREAM_IDLE_TTL, "STREAM_IDLE_TTL", DEFAULT_STREAM_IDLE_TTL_SECONDS),
    streamMaxTtlSeconds: positiveInt(env.STREAM_MAX_TTL, "STREAM_MAX_TTL", DEFAULT_STREAM_MAX_TTL_SECONDS),
    streamFollowSeconds: positiveInt(env.STREAM_FOLLOW_SECONDS, "STREAM_FOLLOW_SECONDS", DEFAULT_STREAM_FOLLOW_SECONDS),
  }
}

/** An optional `https://host` variable, normalised to an origin with no trailing slash. */
function origin(value: string | undefined, name: string): string | null {
  if (value === undefined || value.trim() === "") return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new ConfigError(`${name} must be an origin like https://example.com, got ${JSON.stringify(value)}`)
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError(`${name} must be an origin like https://example.com, got ${JSON.stringify(value)}`)
  }
  return url.origin
}

/**
 * Parses a numeric variable, falling back to `fallback` when unset. An invalid
 * value is a hard error: silently treating it as `NaN` would disable the limit
 * it is meant to enforce.
 */
function positiveInt(value: string | number | undefined, name: string, fallback: number): number {
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got ${JSON.stringify(value)}`)
  }
  return parsed
}
