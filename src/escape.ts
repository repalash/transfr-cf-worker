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
 * True if a value can sit on a command line as it is, in any common shell: sh
 * and friends, PowerShell and Windows cmd.exe. Quoting is not an answer here,
 * because the shells do not agree on it (cmd.exe ignores single quotes), so
 * the pages only ever put values that pass this into a command.
 */
export function isShellPlain(value: string): boolean {
  return /^(?:[A-Za-z0-9_/:.-]|%[0-9A-Fa-f]{2})+$/.test(value) && !value.startsWith("-")
}

/**
 * A file name reduced to characters no shell interprets: letters and digits of
 * any script, `_`, `.` and `-`. Used as the name a command saves a file under.
 */
export function shellSafeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}_.-]+/gu, "_").replace(/^[-.]+/, "") || "download"
}

/**
 * A double quoted string literal that is valid in both JavaScript and Python,
 * for the code snippets on the pages.
 */
export function stringLiteral(value: string): string {
  return JSON.stringify(value)
}
