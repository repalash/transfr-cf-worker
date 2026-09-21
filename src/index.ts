import { ConfigError, loadConfig } from "./config"
import { ALLOWED_METHODS, handleOptions } from "./cors"
import { handleDownload } from "./download"
import type { Env } from "./env"
import { textResponse } from "./http"
import { handleUpload } from "./upload"

export type { Env }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx)
    } catch (error) {
      console.error(error)
      return textResponse(error instanceof ConfigError ? "Server misconfigured\n" : "Internal Server Error\n", 500)
    }
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
        `Method not allowed, send a PUT request to upload a file and GET request to download, for more details read ${url.origin} \n`,
        405,
        { Allow: ALLOWED_METHODS },
      )
  }
}
