/** Only http(s) or same-origin relative URLs reach href/src (meta is replayed from the log). */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || url === '') return undefined
  if (url.startsWith('/') && !url.startsWith('//')) return url
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined
  } catch {
    return undefined
  }
}
