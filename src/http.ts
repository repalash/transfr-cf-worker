import { corsHeaders } from "./cors"

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

/** For everything that must stay out of search engines: files, file pages, duplicate hosts. */
export const NO_INDEX = "noindex, nofollow"

/**
 * Content Security Policy for the worker's own HTML pages. Scripts, styles and
 * fonts all come from this origin (public/assets), with no inline script, so
 * markup that somehow got into a page still could not run anything.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ")

export function textResponse(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": TEXT_CONTENT_TYPE, ...corsHeaders, ...extraHeaders },
  })
}

export function htmlResponse(
  html: string,
  { withBody = true, extraHeaders = {} }: { withBody?: boolean; extraHeaders?: Record<string, string> } = {},
): Response {
  return new Response(withBody ? html : null, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders,
      ...extraHeaders,
    },
  })
}

export function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...extraHeaders },
  })
}

/**
 * An error: one line of text that says what to change, plus a short stable
 * code in `X-Error-Code` for programs, which should not have to match prose.
 */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return textResponse(`${message}\n`, status, {
    "X-Error-Code": code,
    "Access-Control-Expose-Headers": "X-Error-Code",
    ...extraHeaders,
  })
}

/** `origin`, when given, adds where to find the instructions: a wrong link is often a guess at the API. */
export function notFound(ttlLabel: string, origin?: string): Response {
  const usage = origin ? ` Usage: ${origin}/llms.txt` : ""
  return errorResponse(
    "not_found",
    `Not found: the link is wrong, or the file has expired. Files are deleted ${ttlLabel} after upload.${usage}`,
    404,
  )
}

/**
 * True for a browser opening a page in a tab, as opposed to `fetch()`, an
 * `<img>` or `<video>`, curl or a script. `Sec-Fetch-Dest` is sent by every
 * current browser; older ones and link previewers are judged by `Accept`.
 */
export function isNavigation(request: Request): boolean {
  const destination = request.headers.get("sec-fetch-dest")
  if (destination !== null) return destination === "document"
  return accepts(request, "text/html")
}

/**
 * True if JSON is what the client prefers: its Accept header lists
 * application/json above plain text, HTML and "anything". Libraries such as
 * axios list JSON, plain text and "anything" as equals on every request,
 * without the caller asking for it; they keep the plain text replies they
 * always got. A client that asks for JSON with a low priority fallback, as
 * jQuery does, gets JSON.
 */
export function wantsJson(request: Request): boolean {
  const json = quality(request, "application/json")
  const others = ["text/plain", "text/html", "*/*"].map((type) => quality(request, type))
  return json > 0 && json > Math.max(...others)
}

/** The weight (q-value) the Accept header gives a media type; 0 if it is not listed. */
function quality(request: Request, type: string): number {
  for (const entry of (request.headers.get("accept") ?? "").toLowerCase().split(",")) {
    const [name, ...parameters] = entry.split(";").map((part) => part.trim())
    if (name !== type) continue
    const q = parameters.find((parameter) => parameter.startsWith("q="))
    const weight = q === undefined ? 1 : Number(q.slice(2))
    return Number.isFinite(weight) ? weight : 0
  }
  return 0
}

/**
 * Command line tools and HTTP libraries, by the start of their User-Agent.
 * PowerShell is the exception: its User-Agent starts like a browser's.
 */
const CLI_USER_AGENT =
  /^(curl|wget|httpie|python|go-http-client|node|undici|axios|deno|bun|okhttp|java|ruby|libwww-perl)\b|powershell\//i

/**
 * True if the landing page should be the plain text guide rather than HTML:
 * for command line tools, scripts and anything that asks for text. Browsers,
 * search engines and link previewers (which often accept anything) are not
 * matched, so they keep getting the page with its metadata.
 */
export function prefersTextGuide(request: Request): boolean {
  if (accepts(request, "text/html")) return false
  if (accepts(request, "text/plain") || accepts(request, "text/markdown")) return true
  return CLI_USER_AGENT.test(request.headers.get("user-agent") ?? "")
}

function accepts(request: Request, type: string): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes(type)
}

/** The JSON form of a plain text error reply, for clients that asked for JSON. */
export async function errorAsJson(response: Response): Promise<Response> {
  if (!(response.headers.get("content-type") ?? "").startsWith("text/plain")) return response
  const headers = new Headers(response.headers)
  headers.set("Content-Type", "application/json; charset=utf-8")
  const code = response.headers.get("x-error-code") ?? undefined
  const body = { error: (await response.text()).trim(), code, status: response.status }
  return new Response(`${JSON.stringify(body)}\n`, { status: response.status, headers })
}
