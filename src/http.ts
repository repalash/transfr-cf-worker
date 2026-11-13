import { corsHeaders } from "./cors"

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

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

export function notFound(): Response {
  return textResponse("Not Found\n", 404)
}
