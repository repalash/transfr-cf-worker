import accessTemplate from "../html/access.html"
import indexTemplate from "../html/index.html"
import type { Config } from "./config"
import { escapeHtml, isShellPlain, jsonForScript, shellSafeName, stringLiteral } from "./escape"
import { formatBytes, formatDuration, formatRelativeTo } from "./format"
import { render } from "./templates"

export function renderIndexPage(origin: string, config: Config): string {
  const maxFileSizeLabel = formatBytes(config.maxFileSizeBytes)
  const ttlLabel = formatDuration(config.fileTtlSeconds)
  return render(indexTemplate, {
    CONFIG_JSON: jsonForScript({
      maxFileSizeBytes: config.maxFileSizeBytes,
      maxFileSizeLabel,
      ttlLabel,
    }),
    ORIGIN: escapeHtml(origin),
    MAX_FILE_SIZE_LABEL: escapeHtml(maxFileSizeLabel),
    MAX_BUFFERED_FILE_SIZE_LABEL: escapeHtml(formatBytes(config.maxBufferedFileSizeBytes)),
    TTL_LABEL: escapeHtml(ttlLabel),
  })
}

const UNSAFE_LINK_NOTE =
  "# This link has characters that are not safe to paste into a terminal. Use the download link above."

export interface AccessPageData {
  /** Decoded file name; untrusted. */
  filename: string
  size: number
  encrypted: boolean
  fileUrl: string
  rawUrl: string
  homeUrl: string
  /** Unix timestamp (seconds) the file expires at, if the key carries one. */
  expiresAt: number | null
  ttlSeconds: number
}

export function renderAccessPage(data: AccessPageData): string {
  const decryptedName = data.encrypted ? data.filename.replace(/\.(pgp|gpg|asc)$/i, "") : data.filename
  // The file name and link are the uploader's, and the commands below are
  // meant to be copied and run. So the output name is reduced to characters no
  // shell interprets (and is never a path), and a link that is not plain is
  // not put into a command at all.
  const saveAs = (name: string) => shellSafeName(name.split("/").pop() ?? "")
  const linkIsPlain = isShellPlain(data.fileUrl)
  const curl = linkIsPlain ? `curl -L ${data.fileUrl} -o ${saveAs(data.filename)}` : UNSAFE_LINK_NOTE
  const curlAndDecrypt = linkIsPlain
    ? `curl -L ${data.fileUrl} | gpg --pinentry-mode loopback -d -o ${saveAs(decryptedName)}`
    : UNSAFE_LINK_NOTE
  return render(accessTemplate, {
    // Values used from JavaScript go through a JSON block: string
    // interpolation into a script body is not safely escapable.
    FILE_INFO_JSON: jsonForScript({
      name: data.filename,
      decryptedName,
      size: data.size,
      encrypted: data.encrypted,
      rawUrl: data.rawUrl,
      expiresAt: data.expiresAt,
    }),
    FILE_NAME: escapeHtml(data.filename),
    FILE_SIZE_LABEL: escapeHtml(`${formatBytes(data.size)} (${data.size} bytes)`),
    CURL_COMMAND: escapeHtml(curl),
    CURL_COMMAND_ENC: escapeHtml(curlAndDecrypt),
    // The code snippets get a string literal, which nothing can break out of.
    FILE_LINK_STR: escapeHtml(stringLiteral(data.fileUrl)),
    FILE_LINK_RAW: escapeHtml(data.rawUrl),
    HOME_LINK: escapeHtml(data.homeUrl),
    TTL_LABEL: escapeHtml(formatDuration(data.ttlSeconds)),
    EXPIRES_LABEL: escapeHtml(data.expiresAt === null ? "unknown" : formatRelativeTo(data.expiresAt)),
    ENCRYPTED_DISPLAY: data.encrypted ? "block" : "none",
    NOT_ENCRYPTED_DISPLAY: data.encrypted ? "none" : "block",
  })
}
