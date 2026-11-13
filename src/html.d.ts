/** HTML pages are bundled as text modules (see the `Text` rule in wrangler.toml). */
declare module "*.html" {
  const content: string
  export default content
}

/** So is the plain text usage guide. */
declare module "*.txt" {
  const content: string
  export default content
}
