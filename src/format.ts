const SIZE_UNITS = ["KB", "MB", "GB", "TB"]

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return plural(seconds, "second")
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return plural(minutes, "minute")
  const hours = Math.round(minutes / 60)
  if (hours < 48) return plural(hours, "hour")
  return plural(Math.round(hours / 24), "day")
}

/** "in 23 hours" for a future unix timestamp (seconds). */
export function formatRelativeTo(timestampSeconds: number, now: number = Date.now()): string {
  const remaining = Math.round(timestampSeconds - now / 1000)
  return remaining <= 0 ? "now" : `in ${formatDuration(remaining)}`
}

function plural(count: number, unit: string): string {
  return `${count} ${count === 1 ? unit : `${unit}s`}`
}
