/** Methods the worker actually implements; also what OPTIONS advertises. */
export const ALLOWED_METHODS = "GET, HEAD, POST, PUT, OPTIONS"

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": ALLOWED_METHODS,
  "Access-Control-Max-Age": "86400",
}

export function handleOptions(request: Request): Response {
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers")
  const isPreflight =
    request.headers.get("Origin") !== null && request.headers.get("Access-Control-Request-Method") !== null

  if (isPreflight) {
    return new Response(null, {
      headers: {
        ...corsHeaders,
        // Echo the requested headers back so clients may send Content-Type etc.
        ...(requestedHeaders ? { "Access-Control-Allow-Headers": requestedHeaders } : {}),
        Vary: "Origin, Access-Control-Request-Headers",
      },
    })
  }

  return new Response(null, { headers: { ...corsHeaders, Allow: ALLOWED_METHODS } })
}
