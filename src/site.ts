import type { Config } from "./config"
import { htmlResponse, NO_INDEX, prefersTextGuide, textResponse } from "./http"
import { renderGuide, renderIndexPage } from "./pages"

const ONE_HOUR = { "Cache-Control": "public, max-age=3600" }
/** The landing page is HTML or the text guide depending on these. */
const VARY_ON_CLIENT = "Accept, User-Agent"

/**
 * The pages the site itself serves: the landing page, the plain text guide and
 * the files crawlers look for. Returns null for any other path. Uploaded files
 * always live under a `<random>-<expiry>/` prefix, so none of these paths can
 * collide with one.
 */
export function siteResponse(request: Request, url: URL, config: Config, path: string): Response | null {
  const canonicalOrigin = config.canonicalOrigin ?? url.origin
  const response = respond(request, url, config, path, canonicalOrigin)
  if (response === null) return null
  return request.method === "HEAD" ? new Response(null, response) : response
}

function respond(request: Request, url: URL, config: Config, path: string, canonicalOrigin: string): Response | null {
  switch (path) {
    case "":
      if (prefersTextGuide(request)) {
        return textResponse(renderGuide(url.origin, config), 200, { Vary: VARY_ON_CLIENT })
      }
      return htmlResponse(renderIndexPage(url.origin, canonicalOrigin, config), {
        extraHeaders: {
          Vary: VARY_ON_CLIENT,
          Link: `<${url.origin}/llms.txt>; rel="alternate"; type="text/plain"`,
          // Only the canonical address is for search engines; the same page on
          // any other host this worker answers on would be a duplicate.
          ...(url.origin === canonicalOrigin ? {} : { "X-Robots-Tag": NO_INDEX }),
        },
      })
    case "llms.txt":
      return textResponse(renderGuide(url.origin, config), 200, ONE_HOUR)
    case "robots.txt":
      return textResponse(`User-agent: *\nAllow: /\n\nSitemap: ${canonicalOrigin}/sitemap.xml\n`, 200, ONE_HOUR)
    case "sitemap.xml":
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${canonicalOrigin}/</loc></url></urlset>\n`,
        { headers: { "Content-Type": "application/xml; charset=utf-8", ...ONE_HOUR } },
      )
    default:
      return null
  }
}
