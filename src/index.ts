import { ConfigError, loadConfig } from "./config"
import { ALLOWED_METHODS, handleOptions } from "./cors"
import { handleDownload } from "./download"
import type { Env } from "./env"
import { errorAsJson, textResponse, wantsJson } from "./http"
import { handleUpload } from "./upload"

export type { Env }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let response: Response
    try {
      response = await route(request, env, ctx)
    } catch (error) {
      console.error(error)
      response = textResponse(error instanceof ConfigError ? "Server misconfigured\n" : "Internal Server Error\n", 500)
    }
    // Errors are one line of text; a client that asked for JSON gets them as JSON.
    return response.status >= 400 && wantsJson(request) ? await errorAsJson(response) : response
  },
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") return handleOptions(request)

  const config = loadConfig(env)
  const url = new URL(request.url)

  switch (request.method) {
    case "PUT":
    case "POST":
      return await handleUpload(request, url, config)
    case "GET":
    case "HEAD":
      return await handleDownload(request, url, config, ctx)
    default:
      return textResponse(
        `Method not allowed: send PUT or POST to upload a file and GET to download it. Usage: ${url.origin}/llms.txt\n`,
        405,
        { Allow: ALLOWED_METHODS },
      )
  }
}
