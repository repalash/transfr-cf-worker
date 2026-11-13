/**
 * Worker bindings and configuration variables.
 *
 * `R2_DEFAULT_NAMESPACE` names the R2 binding to store objects in, so the same
 * code can be deployed against differently named buckets without a rebuild.
 */
export interface Env {
  /** Name of the R2 bucket binding to use, e.g. `TEMP_STORE_R2_1`. */
  R2_DEFAULT_NAMESPACE: string
  /** Maximum accepted upload size, in bytes, for uploads with a Content-Length. */
  R2_MAX_FILE_SIZE_BYTES?: string | number
  /**
   * Maximum size, in bytes, of an upload without a Content-Length (chunked),
   * which has to be buffered in memory. Capped at R2_MAX_FILE_SIZE_BYTES.
   */
  R2_MAX_BUFFERED_FILE_SIZE_BYTES?: string | number
  /** Lifetime of an uploaded file, in seconds. */
  R2_DEFAULT_FILE_TTL?: string | number
  /**
   * Comma separated hostnames that always serve the stored bytes and never the
   * HTML landing page, even for browsers (used for hotlinking/embedding).
   */
  RAW_ONLY_HOSTS?: string
  /**
   * Origin search engines should index, e.g. `https://transfr.one`. Unset, each
   * host the worker answers on is its own canonical address.
   */
  CANONICAL_ORIGIN?: string
  /** Seconds a pipe's sender or receiver waits for the other side. Default 300. */
  PIPE_WAIT_SECONDS?: string | number
  /** Largest a stream may grow, in bytes. Default 1 GB (1,073,741,824). */
  STREAM_MAX_BYTES?: string | number
  /** Seconds after its last write that a stream is deleted. Default 86400. */
  STREAM_IDLE_TTL?: string | number
  /** Seconds after its creation that a stream is deleted at the latest. Default 604800. */
  STREAM_MAX_TTL?: string | number
  /** Seconds a `?follow` connection is kept open before the reader has to reconnect. Default 3600. */
  STREAM_FOLLOW_SECONDS?: string | number
  /** The Durable Object that connects pipes and stores streams. Unbound, both are switched off. */
  CHANNELS?: DurableObjectNamespace
  /** Rate limiter for uploads, keyed by client address. Unbound, uploads are not limited. */
  UPLOAD_LIMITER?: RateLimit
  /** R2 bucket bindings (and anything else Cloudflare injects). */
  [binding: string]: unknown
}
