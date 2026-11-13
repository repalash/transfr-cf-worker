// Checks what the vitest suite cannot see from inside workerd: that every
// /assets/... file the pages, their scripts and the stylesheet reference exists
// under public/, and that the vendored OpenPGP.js is still the exact file that
// was reviewed. It is loaded by a worker, where the browser cannot check an
// integrity hash itself, so the hash is checked here instead.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

const failures = []
const publicPath = (urlPath) => join("public", urlPath.split(/[?#]/)[0])

for (const page of readdirSync("html").filter((name) => name.endsWith(".html"))) {
  const html = readFileSync(join("html", page), "utf8")
  for (const [tag] of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
    const url = /\b(?:src|href)="([^"]+)"/.exec(tag)?.[1]
    if (!url) continue
    // Links that are not files to load: the canonical address, the text guide.
    const rel = /\brel="([^"]+)"/.exec(tag)?.[1]
    if (rel === "canonical" || rel === "alternate") continue
    if (!url.startsWith("/assets/") && url !== "/favicon.ico") {
      failures.push(`${page}: ${url} is not served from /assets/`)
      continue
    }
    if (!existsSync(publicPath(url))) {
      failures.push(`${page}: ${url} does not exist under public/`)
      continue
    }
    const integrity = /\bintegrity="(sha(?:256|384|512))-([^"]+)"/.exec(tag)
    if (integrity) {
      const actual = createHash(integrity[1]).update(readFileSync(publicPath(url))).digest("base64")
      if (actual !== integrity[2]) failures.push(`${page}: integrity of ${url} should be ${integrity[1]}-${actual}`)
    }
  }
}

// Built into absolute URLs in src/pages.ts, for share previews.
for (const image of ["public/assets/og.png", "public/assets/apple-touch-icon.png"]) {
  if (!existsSync(image)) failures.push(`${image} is missing: the share preview tags point at it`)
}

// Modules, workers and scripts that the page scripts load in turn.
for (const script of readdirSync("public/assets").filter((name) => name.endsWith(".js") && !name.endsWith(".min.js"))) {
  const source = readFileSync(join("public/assets", script), "utf8")
  for (const [, url] of source.matchAll(/(?:from\s+|import\s*\(|new Worker\(|importScripts\()\s*["'](\/assets\/[^"']+)["']/g)) {
    if (!existsSync(publicPath(url))) failures.push(`${script}: ${url} does not exist under public/`)
  }
}

// Replace the file and this hash together when updating OpenPGP.js (see public/assets/NOTICE.md).
const PINNED = {
  "public/assets/openpgp.min.js": "sha384-FhdcYfX+EgAqf1TSB8S+o5Ry3y5nAHjxyxeSPyrzybvQhoCm4Xpap33cFJY4JB8r",
}
for (const [file, expected] of Object.entries(PINNED)) {
  const [algorithm] = expected.split("-")
  const actual = `${algorithm}-${createHash(algorithm).update(readFileSync(file)).digest("base64")}`
  if (actual !== expected) failures.push(`${file} has changed: its hash is ${actual}, the pinned one is ${expected}`)
}

const stylesheet = "public/assets/style.css"
for (const [, url] of readFileSync(stylesheet, "utf8").matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
  if (url.startsWith("data:")) continue
  if (/^(?:[a-z]+:)?\/\//i.test(url)) failures.push(`${stylesheet}: ${url} points at another site`)
  else if (!existsSync(join(dirname(stylesheet), url))) failures.push(`${stylesheet}: ${url} does not exist`)
}

if (failures.length > 0) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log("page assets: all referenced files exist and the pinned hashes match")
