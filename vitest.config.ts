import { readFileSync } from "node:fs"
import { cloudflareTest } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

/**
 * Mirrors the `Text` module rule from wrangler.toml so that
 * `import page from "../html/page.html"` resolves to the file's contents here
 * too.
 */
const htmlAsText = {
  name: "html-as-text",
  enforce: "pre" as const,
  load(id: string) {
    const file = id.split("?")[0]
    if (!file.endsWith(".html")) return null
    return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`
  },
}

export default defineConfig({
  plugins: [htmlAsText, cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
})
