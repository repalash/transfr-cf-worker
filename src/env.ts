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
  /** R2 bucket bindings (and anything else Cloudflare injects). */
  [binding: string]: unknown
}
