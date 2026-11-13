import { Channel } from "./channel"
import { handleChannel } from "./channels"
import { ConfigError, loadConfig } from "./config"
import { ALLOWED_METHODS, handleOptions } from "./cors"
import { handleDownload } from "./download"
import type { Env } from "./env"
import { errorAsJson, errorResponse, wantsJson } from "./http"
import { handleUpload } from "./upload"

export type { Env }
// Durable Object classes have to be exported from the entry module.
export { Channel }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response
    try {
      response = await route(request, env, ctx)
    } catch (error) {
      console.error(error)
      response =
        error instanceof ConfigError
          ? errorResponse("misconfigured", "Server misconfigured", 500)
          : errorResponse("internal_error", "Internal Server Error", 500)
    }
    // Errors are one line of text; a client that asked for JSON gets them as JSON.
    return response.status >= 400 && wantsJson(request) ? await errorAsJson(response) : response
  },
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions(request)

  const config = loadConfig(env)
  const url = new URL(request.url)

  // Anything that sends data counts against one of the client's rate limits.
  if (request.method === "PUT" || request.method === "POST") {
    const limited = await rateLimited(request, url, env)
    if (limited) return limited
  }

  // /pipe/... and /stream/...
  const channel = await handleChannel(request, url, env, config)
  if (channel) return channel

  switch (request.method) {
    case "PUT":
    case "POST":
      return await handleUpload(request, url, config)
    case "GET":
    case "HEAD":
      return await handleDownload(request, url, config, ctx)
    default:
      return errorResponse(
        "method_not_allowed",
        `Method not allowed: send PUT or POST to upload a file and GET to download it. Usage: ${url.origin}/llms.txt`,
        405,
        { Allow: ALLOWED_METHODS },
      )
  }
}

/** A write to a stream that already exists: `/stream/<id>/<name>`. */
const STREAM_WRITE_PATH = /^\/+stream\/[0-9a-f]{12}\//

/**
 * A 429 if this client has sent too much too quickly, otherwise null. Writes
 * to an existing stream have their own, higher, limit: a script that logs a
 * line at a time sends far more requests than anyone uploading files.
 */
async function rateLimited(request: Request, url: URL, env: Env): Promise<Response | null> {
  // The client's address is set by Cloudflare on every request. Without it
  // (local development, tests) there is no one to count against.
  const address = request.headers.get("cf-connecting-ip")
  const isStreamWrite = STREAM_WRITE_PATH.test(url.pathname)
  const limiter = isStreamWrite ? env.STREAM_WRITE_LIMITER : env.UPLOAD_LIMITER
  if (!limiter || !address) return null
  const { success } = await limiter.limit({ key: address })
  if (success) return null
  const what = isStreamWrite ? "writes to streams" : "uploads"
  return errorResponse("rate_limited", `Too many ${what} from your address. Wait a minute and try again.`, 429, {
    "Retry-After": "60",
  })
}
