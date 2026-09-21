import accessTemplate from "../html/access.html"
import indexTemplate from "../html/index.html"
import type { Config } from "./config"
import { escapeHtml, jsonForScript } from "./escape"
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
    TTL_LABEL: escapeHtml(ttlLabel),
  })
}

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
    FILE_NAME_RAW: escapeHtml(decryptedName),
    FILE_SIZE_LABEL: escapeHtml(`${formatBytes(data.size)} (${data.size} bytes)`),
    FILE_LINK: escapeHtml(data.fileUrl),
    FILE_LINK_RAW: escapeHtml(data.rawUrl),
    HOME_LINK: escapeHtml(data.homeUrl),
    TTL_LABEL: escapeHtml(formatDuration(data.ttlSeconds)),
    EXPIRES_LABEL: escapeHtml(data.expiresAt === null ? "unknown" : formatRelativeTo(data.expiresAt)),
    ENCRYPTED_DISPLAY: data.encrypted ? "block" : "none",
    NOT_ENCRYPTED_DISPLAY: data.encrypted ? "none" : "block",
  })
}
