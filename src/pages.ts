import accessTemplate from "../html/access.html"
import indexTemplate from "../html/index.html"
import guideTemplate from "../html/llms.txt"
import type { Config } from "./config"
import { escapeHtml, isShellPlain, jsonForScript, shellSafeName, stringLiteral } from "./escape"
import { formatBytes, formatDuration, formatRelativeTo } from "./format"
import { render } from "./templates"

export function renderIndexPage(origin: string, canonicalOrigin: string, config: Config): string {
  const maxFileSizeLabel = formatBytes(config.maxFileSizeBytes)
  const ttlLabel = formatDuration(config.fileTtlSeconds)
  const description =
    `Send a file with one curl command or a drag and drop. Encrypted end to end in your browser, ` +
    `deleted after ${ttlLabel}. No account, free and open source.`
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
    // Search engines and share previews are pointed at one address, whichever
    // host the page was fetched from.
    DESCRIPTION: escapeHtml(description),
    CANONICAL_URL: escapeHtml(`${canonicalOrigin}/`),
    SHARE_IMAGE_URL: escapeHtml(`${canonicalOrigin}/assets/og.png`),
    STRUCTURED_DATA_JSON: jsonForScript({
      "@context": "https://schema.org",
      "@type": "WebApplication",
      name: "transfr.one",
      url: `${canonicalOrigin}/`,
      description,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any",
      isAccessibleForFree: true,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    }),
  })
}

/** The usage guide as plain text: what curl, scripts and AI agents get. */
export function renderGuide(origin: string, config: Config): string {
  return render(guideTemplate, {
    ORIGIN: origin,
    TTL_LABEL: formatDuration(config.fileTtlSeconds),
    MAX_FILE_SIZE_LABEL: formatBytes(config.maxFileSizeBytes),
    MAX_FILE_SIZE_BYTES: String(config.maxFileSizeBytes),
    MAX_BUFFERED_FILE_SIZE_LABEL: formatBytes(config.maxBufferedFileSizeBytes),
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
  /** Origin the share preview's image is loaded from. */
  siteOrigin: string
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
    // What a chat app shows when the link is pasted into it.
    SHARE_DESCRIPTION: escapeHtml(
      `${formatBytes(data.size)}${data.encrypted ? ", encrypted" : ""}. Shared with transfr.one` +
        (data.expiresAt === null ? "." : `, expires ${formatRelativeTo(data.expiresAt)}.`),
    ),
    SHARE_IMAGE_URL: escapeHtml(`${data.siteOrigin}/assets/apple-touch-icon.png`),
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
