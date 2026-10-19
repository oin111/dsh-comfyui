/** Bounded, instance-scoped object_info cache. Invalidated flights may finish
 * for existing callers, but can never repopulate a newer cache generation. */
export class ObjectInfoCache {
  private readonly entries = new Map<string, {
    value?: Record<string, unknown>
    expiresAt?: number
    pending?: Promise<Record<string, unknown>>
  }>()

  constructor(private readonly ttlMs = 60_000, private readonly maxEntries = 16) {}

  clear(): void {
    this.entries.clear()
  }

  get(key: string, load: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const existing = this.entries.get(key)
    if (existing?.pending !== undefined) return existing.pending
    if (existing?.value !== undefined && (existing.expiresAt ?? 0) > Date.now()) {
      return Promise.resolve(existing.value)
    }
    const entry: { value?: Record<string, unknown>; expiresAt?: number; pending?: Promise<Record<string, unknown>> } = {}
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    entry.pending = Promise.resolve().then(load).then(value => {
      if (this.entries.get(key) === entry) {
        entry.value = value
        entry.expiresAt = Date.now() + this.ttlMs
        entry.pending = undefined
      }
      return value
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      throw error
    })
    return entry.pending
  }
}
