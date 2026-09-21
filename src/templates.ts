/**
 * Fills `{{TOKEN}}` placeholders in a template in a single pass.
 *
 * Single pass matters: with sequential `String.replace` calls, a value
 * substituted early (a file name, say) is re-scanned by later replacements and
 * can inject placeholders of its own.
 */
export function render(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, token: string) =>
    Object.prototype.hasOwnProperty.call(values, token) ? values[token] : match,
  )
}
