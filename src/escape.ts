/** U+2028 and U+2029 terminate a line in JavaScript source. */
const LINE_SEPARATORS = new RegExp("[\\u2028\\u2029]", "g")

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/**
 * Escapes text for interpolation into element content or a quoted attribute.
 * File names and URLs are attacker controlled, so everything rendered into a
 * page has to go through here.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

/**
 * Serialises a value for embedding in a `<script type="application/json">`
 * block. Markup characters are escaped so the payload can never end the script
 * element or be re-parsed as markup.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATORS, (char) => (char.charCodeAt(0) === 0x2028 ? "\\u2028" : "\\u2029"))
}

/**
 * Quotes a value for a POSIX shell command line. The pages show commands to
 * copy and paste that contain file names and links chosen by the uploader, so
 * anything but plain characters is wrapped in single quotes, where the shell
 * interprets nothing.
 */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_/:=@%+,.-]+$/.test(value) && !value.startsWith("-")) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A double quoted string literal that is valid in both JavaScript and Python,
 * for the code snippets on the pages.
 */
export function stringLiteral(value: string): string {
  return JSON.stringify(value)
}
