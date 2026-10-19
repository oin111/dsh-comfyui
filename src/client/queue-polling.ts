/** One visibility-aware queue poller per mounted task-center tab. A poll owns
 * every request until all have settled, even if one fails immediately. */
export interface QueuePoller {
  refresh(): void
  dispose(): void
}

/** Shared across mounts (including React StrictMode effect replay). Aborting a
 * fetch is asynchronous; a replacement tab must wait for its predecessor's
 * entire request group to drain before starting its own requests. */
let queueRead: Promise<unknown> | undefined

export function createQueuePoller<T>(options: {
  read(signal: AbortSignal): Array<Promise<T>>
  apply(values: T[]): void
  fail(cause: unknown): void
  intervalMs?: number
  timeoutMs?: number
}): QueuePoller {
  let disposed = false
  let running = false
  let requested = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined

  const clearTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const clearDeadline = (): void => {
    if (deadline !== undefined) clearTimeout(deadline)
    deadline = undefined
  }
  const cancelRead = (): void => {
    clearDeadline()
    controller?.abort()
  }
  const current = (version: number): boolean => !disposed && !document.hidden && generation === version

  const poll = async (): Promise<void> => {
    if (disposed || document.hidden || running) return
    clearTimer()
    running = true
    requested = false
    const version = generation
    try {
      while (queueRead !== undefined) {
        await queueRead
        if (!current(version)) return
      }
      if (!current(version)) return
      controller = new AbortController()
      deadline = setTimeout(() => controller?.abort(), options.timeoutMs ?? 30_000)
      // Promise.all releases its caller as soon as one request rejects. The
      // sibling request must also settle before another polling cycle starts.
      const pending = Promise.allSettled(options.read(controller.signal)).finally(() => {
        if (queueRead === pending) queueRead = undefined
      })
      queueRead = pending
      const results = await pending
      if (!current(version)) return
      const values = results.map(result => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      options.apply(values)
    } catch (cause) {
      if (current(version)) options.fail(cause)
    } finally {
      clearDeadline()
      controller = undefined
      running = false
      if (!disposed && !document.hidden) {
        if (requested) void poll()
        else timer = setTimeout(() => { timer = undefined; void poll() }, options.intervalMs ?? 3_000)
      }
    }
  }

  const refresh = (): void => {
    if (disposed) return
    generation++
    requested = true
    clearTimer()
    cancelRead()
    void poll()
  }
  const visibilityChanged = (): void => {
    // Hiding invalidates/aborts the current read and clears the timer. Showing
    // requests fresh data, while preserving the shared single-flight gate.
    refresh()
  }
  document.addEventListener('visibilitychange', visibilityChanged)
  refresh()
  return {
    refresh,
    dispose(): void {
      disposed = true
      generation++
      clearTimer()
      cancelRead()
      document.removeEventListener('visibilitychange', visibilityChanged)
    },
  }
}
