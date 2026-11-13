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

  // Anything that sends data counts against the client's rate limit.
  if (request.method === "PUT" || request.method === "POST") {
    const limited = await rateLimited(request, env)
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

/** A 429 if this client has sent too much too quickly, otherwise null. */
async function rateLimited(request: Request, env: Env): Promise<Response | null> {
  // The client's address is set by Cloudflare on every request. Without it
  // (local development, tests) there is no one to count against.
  const address = request.headers.get("cf-connecting-ip")
  if (!env.UPLOAD_LIMITER || !address) return null
  const { success } = await env.UPLOAD_LIMITER.limit({ key: address })
  if (success) return null
  return errorResponse("rate_limited", "Too many uploads from your address. Wait a minute and try again.", 429, {
    "Retry-After": "60",
  })
}
