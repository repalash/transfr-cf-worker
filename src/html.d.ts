/** HTML pages are bundled as text modules (see the `Text` rule in wrangler.toml). */
declare module "*.html" {
  const content: string
  export default content
}
