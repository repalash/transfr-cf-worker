import type { Env } from "./env"

/** Longest accepted URL path (the file name) for an upload. */
export const MAX_FILENAME_LENGTH = 256

const DEFAULT_MAX_FILE_SIZE_BYTES = 21_000_000 // 20 MB
const DEFAULT_FILE_TTL_SECONDS = 86_400 // 24 hours

export interface Config {
  bucket: R2Bucket
  maxFileSizeBytes: number
  fileTtlSeconds: number
  rawOnlyHosts: string[]
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

  return {
    bucket,
    maxFileSizeBytes: positiveInt(
      env.R2_MAX_FILE_SIZE_BYTES,
      "R2_MAX_FILE_SIZE_BYTES",
      DEFAULT_MAX_FILE_SIZE_BYTES,
    ),
    fileTtlSeconds: positiveInt(env.R2_DEFAULT_FILE_TTL, "R2_DEFAULT_FILE_TTL", DEFAULT_FILE_TTL_SECONDS),
    rawOnlyHosts: (env.RAW_ONLY_HOSTS ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
  }
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
