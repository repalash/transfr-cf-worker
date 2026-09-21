import { corsHeaders } from "./cors"

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"

/**
 * Content Security Policy for the worker's own HTML pages. The pages load
 * OpenPGP.js and simple-dropzone from jsDelivr and the StackEdit stylesheet,
 * and talk to this origin only; everything else is denied.
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://stackedit.io",
  "font-src https://stackedit.io data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://cdn.jsdelivr.net",
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

export function htmlResponse(html: string, { withBody = true }: { withBody?: boolean } = {}): Response {
  return new Response(withBody ? html : null, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...corsHeaders,
    },
  })
}

export function notFound(): Response {
  return textResponse("Not Found\n", 404)
}
