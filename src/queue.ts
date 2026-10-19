/**
 * Queue tracking: remembers every prompt this plugin queued (from tools or
 * the panel) so the panel can show "ours" in the ComfyUI queue and move
 * completed runs into the asset index. Sweeps run on read (queue/assets
 * routes), so no background timers leak into the fiber lifecycle.
 */
import { ComfyUIClient, collectMedia, hasMedia, type ComfyUIHistoryEntry } from './comfyui.js'
import type { AssetRecord, ComfyUIStore, TrackedState } from './store.js'

/** A prompt this plugin queued. Kept after completion so the task center
 * can still show its workflow name and "ours" marker. */
export interface QueuedRun {
  promptId: string
  ts: string
  workflowName: string | null
  source: string
}

/** Upper bound on remembered runs; oldest are dropped beyond this. */
const MAX_TRACKED_RUNS = 500

/** Tracks queued prompts until they complete or vanish. */
export class QueueTracker {
  private readonly runs = new Map<string, QueuedRun>()
  /** Prompt ids already swept into the asset index, so sweep is idempotent. */
  private readonly archived = new Set<string>()
  private pendingState: TrackedState | undefined
  private saving = false
  private savedState: string | undefined
  private retryPersistence = false
  private sweeping: Promise<AssetRecord[]> | undefined

  /**
   * Optional durable backing: the tracked memory is persisted so completed
   * runs still land in the asset index after a web-server restart.
   */
  constructor(private readonly persisted?: {
    load(): Promise<TrackedState>
    save(state: TrackedState): Promise<void>
  }) {}

  /** Restore persisted runs/archived state; call once before tracking. */
  async init(): Promise<void> {
    if (this.persisted === undefined) return
    const state = await this.persisted.load()
    for (const run of state.runs) {
      this.runs.set(run.promptId, {
        promptId: run.promptId,
        ts: run.ts,
        workflowName: run.workflowName,
        source: run.source,
      })
    }
    for (const id of state.archived) this.archived.add(id)
    this.savedState = JSON.stringify(state)
    if (this.trim()) this.persistNow()
  }

  /** Keep runs and their archived markers bounded together, including on restore. */
  private trim(): boolean {
    let changed = false
    while (this.runs.size > MAX_TRACKED_RUNS) {
      const oldest = this.runs.keys().next().value
      if (oldest === undefined) break
      this.runs.delete(oldest)
      changed = true
    }
    for (const id of this.archived) {
      if (!this.runs.has(id)) {
        this.archived.delete(id)
        changed = true
      }
    }
    return changed
  }

  /** Coalesce queued snapshots and serialize writes: an older save can never
   * finish after a newer one. A failed save must not poison later updates. */
  private persistNow(): void {
    if (this.persisted === undefined) return
    this.pendingState = {
      runs: this.list(),
      archived: [...this.archived],
    }
    if (this.saving) return
    this.saving = true
    void this.savePending()
  }

  private async savePending(): Promise<void> {
    try {
      while (this.pendingState !== undefined) {
        const state = this.pendingState
        this.pendingState = undefined
        const serialized = JSON.stringify(state)
        if (serialized === this.savedState && !this.retryPersistence) continue
        try {
          await this.persisted!.save(state)
          this.savedState = serialized
          this.retryPersistence = false
        } catch {
          this.retryPersistence = true
          // Keep the dirty flag for the next track/sweep rather than spinning
          // on a failing disk. Healthy unchanged reads never trigger a write.
        }
      }
    } finally {
      this.saving = false
    }
  }

  track(run: QueuedRun): void {
    const previous = this.runs.get(run.promptId)
    if (previous?.ts === run.ts && previous.workflowName === run.workflowName && previous.source === run.source) {
      if (this.retryPersistence) this.persistNow()
      return
    }
    this.archived.delete(run.promptId)
    this.runs.set(run.promptId, { ...run })
    this.trim()
    this.persistNow()
  }

  untrack(promptId: string): void {
    const removed = this.runs.delete(promptId)
    const unarchived = this.archived.delete(promptId)
    if (removed || unarchived || this.retryPersistence) this.persistNow()
  }

  get(promptId: string): QueuedRun | undefined {
    const run = this.runs.get(promptId)
    return run === undefined ? undefined : { ...run }
  }

  list(): QueuedRun[] {
    return [...this.runs.values()].map(run => ({ ...run }))
  }

  /**
   * Move completed tracked runs into the asset store. Runs already archived
   * are skipped; failed runs stay tracked so their task rows keep a name.
   * @returns the records newly appended.
   */
  sweep(opts: {
    client: ComfyUIClient
    store: ComfyUIStore
    maxItems: number
    proxyBase: string | undefined
  }): Promise<AssetRecord[]> {
    // Queue and asset routes may sweep concurrently. Share the entire operation,
    // including asset appends, rather than racing to archive the same prompts.
    if (this.sweeping !== undefined) return this.sweeping
    const pending = this.sweepNow(opts).finally(() => { this.sweeping = undefined })
    this.sweeping = pending
    return pending
  }

  private async sweepNow(opts: {
    client: ComfyUIClient
    store: ComfyUIStore
    maxItems: number
    proxyBase: string | undefined
  }): Promise<AssetRecord[]> {
    const completed: AssetRecord[] = []
    let changed = false
    try {
      for (const run of [...this.runs.values()]) {
        if (this.runs.get(run.promptId) !== run || this.archived.has(run.promptId)) continue
        const entry = await opts.client.getHistory(run.promptId).catch(() => undefined)
        if (entry === undefined || this.runs.get(run.promptId) !== run) continue
        if (isCompleted(entry)) {
          const media = collectMedia({ promptId: run.promptId, entry, maxItems: opts.maxItems, proxyBase: opts.proxyBase })
          const record: AssetRecord = {
            promptId: run.promptId,
            ts: run.ts,
            workflowName: run.workflowName,
            source: run.source,
            media,
          }
          await opts.store.appendAsset(record)
          completed.push(record)
          // A run can be untracked or pruned while the append is in flight.
          // Never reintroduce an orphan marker (or mark a replacement archived).
          if (this.runs.get(run.promptId) === run) {
            this.archived.add(run.promptId)
            changed = true
          }
        }
      }
    } finally {
      if (changed || this.retryPersistence) this.persistNow()
    }
    return completed
  }
}

function isCompleted(entry: ComfyUIHistoryEntry): boolean {
  return entry.status?.status_str === 'success'
    || entry.status?.completed === true
    || hasMedia(entry)
}
