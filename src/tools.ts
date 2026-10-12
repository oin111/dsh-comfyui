/**
 * Model-facing tools for dsh-comfyui, registered into the host `tools`
 * registry. `comfyui_run` submits a workflow and returns media results
 * (synchronously or as a background job); `comfyui_object_info` exposes the
 * server's node definitions; `comfyui_workflow` lists and runs saved
 * workflows from the panel-managed workflow library.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import { ComfyUIClient, ComfyUIInterruptedError, collectMedia } from './comfyui.js'
import { TEMPLATES, findTemplate, cloneWorkflow, applyTemplateInputs } from './templates.js'
import type { AssetRecord, LoadSlot, StoredWorkflow } from './store.js'
import type { GraphAnalysis } from './analyze.js'
import type { RunProgress } from './progress.js'
import type { QueuedRun } from './queue.js'
import { refreshParameterMetadata, type Workflow, type WorkflowParameter } from './params.js'
import type { HostHint } from './host-hint.js'
import { SKILL_MAIN, joinFrontmatter, type WorkflowSkillPacks } from './skillpack.js'

/** A workflow saved on the ComfyUI server (userdata/workflows), with extract status. */
export interface ComfyUIComfyWorkflow {
  name: string
  size?: number
  modified?: number
  /** Whether at least one runnable API workflow was extracted from this graph. */
  extracted: boolean
  /** Runnable API workflows extracted from this graph (runnable API workflows). */
  derived: Array<{ libraryId: string; name: string }>
}

/** Live runtime the tools, routes, and proxy share. */
export interface ComfyUIRuntime {
  getConfig(): Config
  /** Resolve the API key per request (credentials store, then environment). */
  getApiKey(): Promise<string | undefined>
  createClient(apiKey: string | undefined): ComfyUIClient
  /** Absolute media proxy URL base: explicit config > admitted request Host > bind-address fallback (LAN detection only for wildcard binds). */
  proxyBase(): string | undefined
  /** Remembers the origin browsers use to reach this server (Host header). */
  hostHint: HostHint
  /** Whether the settings service can persist config writes. */
  settingsWritable(): boolean
  updateConfig(patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
  /** Queue a workflow and track it in the queue tracker. `meta.parameters`
   * applies adjustable parameters (values/random seeds) before submitting. */
  queue(workflow: unknown, meta: {
    workflowName: string | null
    workflowId?: string | null
    source: string
    parameters?: WorkflowParameter[]
    values?: Record<string, unknown>
  }): Promise<string>
  /** Stop tracking a prompt (used when a tool call fails before completion). */
  untrack(promptId: string): void
  /** Every prompt this plugin queued and is still waiting on. */
  trackedRuns(): QueuedRun[]
  /** Live generation progress for one prompt (from the ComfyUI WebSocket). */
  queueProgress(promptId: string): RunProgress | undefined
  /** Saved workflows from the library. */
  listWorkflows(): Promise<StoredWorkflow[]>
  getWorkflow(id: string): Promise<StoredWorkflow | undefined>
  /** Create or update a workflow in the library. */
  saveWorkflow(input: {
    id?: string
    name: string
    description: string
    workflow: unknown
    parameters?: WorkflowParameter[]
    tags?: string[]
    source?: 'user' | 'comfyui'
    comfyuiFile?: string
  }): Promise<{ ok: true; workflow: StoredWorkflow } | { ok: false; error: string }>
  /** Delete a workflow from the library; false when it did not exist. */
  deleteWorkflow(id: string): Promise<boolean>
  /** Per-workflow skill packs (SKILL.md bundles under `<dataDir>/skills/`). */
  skillPacks: WorkflowSkillPacks
  /** Force TTS-Audio-Suite to rescan its voice library (best-effort; false
   * when the server has no such endpoint). Call before re-deriving parameter
   * snapshots so object_info reports newly added voices. */
  refreshVoiceLibrary(): Promise<boolean>
  /** Pixel sizes of panel-uploaded files, keyed by file name. */
  listMediaSizes(): Promise<Record<string, { width: number; height: number }>>
  /** Record the pixel size of one uploaded file. */
  saveMediaSize(name: string, size: { width: number; height: number }): Promise<void>
  /** File name recorded for a content hash (dedup index), if any. */
  lookupMediaHash(hash: string): Promise<string | undefined>
  /** Record a content hash → file name pair for dedup. */
  saveMediaHash(hash: string, name: string): Promise<void>
  /** The load-area slots, in order; `null` is an empty slot the user added.
   * Filled slots are the default source media for loader parameters. */
  loadSlots(): Promise<Array<LoadSlot>>
  /** Persist the load-area slots. */
  saveSlots(slots: Array<LoadSlot>): Promise<void>
  /** The asset index (newest first). */
  listAssets(): Promise<AssetRecord[]>
  /** Remove one asset record from the index, returning what was removed. */
  deleteAsset(promptId: string): Promise<AssetRecord | undefined>
  /** Move completed tracked runs into the asset index. */
  sweep(): Promise<AssetRecord[]>
  /** Workflows the user saved on the ComfyUI server, with extract status. */
  listComfyWorkflows(): Promise<ComfyUIComfyWorkflow[]>
  /** Read one ComfyUI-side saved workflow graph (UI format, not runnable as-is). */
  getComfyWorkflow(file: string): Promise<unknown>
  /** Analyze one ComfyUI-side graph: connected components, groups, dangling nodes. */
  analyzeComfyWorkflow(file: string): Promise<GraphAnalysis | { ok: false; error: string }>
  /** Extract runnable API workflows from a ComfyUI-side graph (all/per component/main flow). */
  extractComfyWorkflow(input: {
    file: string
    mode: 'all' | 'split' | 'main'
  }): Promise<{ ok: true; saved: StoredWorkflow[]; analysis: GraphAnalysis; warnings: string[] } | { ok: false; error: string }>
}

/** Execution identity handed to tool execute. */
interface ToolRunContext {
  /** The live Agent handle; `id` is its SessionId (the jobs owner key since dsh 0.1.7). */
  agent?: { readonly id: string }
  signal: AbortSignal
}

/*
 * Structural slice of the dsh 0.2 jobs contract (@deepseek-ai/dsh-jobs
 * JobSpec / JobHooks / JobOutcome). Kept local so the published typings do
 * not import a package that is not a peer; scripts/test-host-compat.mjs pins
 * the runtime behaviour against the real registry shape.
 */
interface JobHandle {
  readonly id: string
  append(text: string): void
  updateProgress(line: string): void
}
interface JobOutcome {
  status: 'completed' | 'killed' | 'failed'
  detail?: string
  result?: string
}
interface JobSpec {
  kind: string
  label: string
  owner?: string
  run(job: JobHandle): { cancel(reason?: string): void; done: Promise<JobOutcome> }
}
interface JobRegistry {
  start(spec: JobSpec): string
}

/**
 * Which skill packs each agent has already read, for the `requireSkill` gate.
 *
 * Keyed by the live `Agent` handle the tools registry passes as `exec.agent`:
 * one per session and stable across turns, so a WeakMap entry lives exactly as
 * long as the session and needs no eviction pass. An execution without an
 * agent (a direct internal call) is never gated.
 */
const skillPackReads = new WeakMap<object, Set<string>>()

/** Upper bound on the text one `comfyui_skill action: read` returns. The pack
 * caps files at 256 KB, which is still far more than a tool result should
 * inject in one go; a longer file comes back truncated with a marker. */
const MAX_TOOL_READ_CHARS = 40_000

function markSkillPackRead(agent: unknown, workflowId: string): void {
  if (typeof agent !== 'object' || agent === null) return
  const seen = skillPackReads.get(agent)
  if (seen === undefined) skillPackReads.set(agent, new Set([workflowId]))
  else seen.add(workflowId)
}

function hasReadSkillPack(agent: unknown, workflowId: string): boolean {
  if (typeof agent !== 'object' || agent === null) return true
  return skillPackReads.get(agent)?.has(workflowId) === true
}

/** One media item returned by comfyui_run (JSON-safe). */
export interface RunMediaItem {
  filename: string
  subfolder: string
  type: string
  node: string
  index: number
  kind: 'image' | 'video' | 'audio' | 'other'
  url: string
}

/** Synchronous completion result. */
export interface RunResult {
  kind: 'sync'
  promptId: string
  status: 'completed' | 'interrupted'
  elapsedMs: number
  media: RunMediaItem[]
  summary: string
}

/** Background mode result: collect later with job_output. */
export interface BackgroundResult {
  kind: 'background'
  jobId: string
  promptId: string
  label: string
}

/** A minimal ToolDefinition for ctx.tools.register. */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): unknown[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  timeoutMs?: number
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown>
}

/**
 * Start one background generation on the host jobs registry.
 *
 * dsh 0.2 contract: `owner` is the calling session's id (an Agent handle is
 * rejected with `session "[object Object]" has no live agent`), and the model
 * reads what `done` resolves as `result` — an `output` field is ignored, which
 * left `job_output` empty on 0.1.7+. Cancelling stops the poll loop and cancels
 * only this prompt on the ComfyUI side.
 */
export async function startBackgroundRun(options: {
  jobs: Pick<JobRegistry, 'start'>
  runtime: Pick<ComfyUIRuntime, 'proxyBase' | 'untrack' | 'queueProgress'>
  client: Pick<ComfyUIClient, 'waitForCompletion' | 'cancelPrompt'>
  config: Pick<Config, 'pollIntervalMs' | 'maxMediaItems'>
  promptId: string
  label: string
  waitMs: number
  owner: string | undefined
}): Promise<string> {
  const { jobs, runtime, client, config, promptId, label, waitMs, owner } = options
  const spec: JobSpec = {
    kind: 'comfyui',
    label,
    ...(owner !== undefined ? { owner } : {}),
    run: (job: JobHandle) => {
      const controller = new AbortController()
      const startedAt = Date.now()
      let lastProgress = ''
      const done = (async (): Promise<JobOutcome> => {
        try {
          const entry = await client.waitForCompletion({
            promptId,
            timeoutMs: waitMs,
            pollIntervalMs: config.pollIntervalMs,
            signal: controller.signal,
            onPoll: () => {
              const progress = runtime.queueProgress(promptId)
              if (progress === undefined || progress.max <= 0) return
              const line = `${label}: ${progress.value}/${progress.max}`
              if (line !== lastProgress) {
                lastProgress = line
                job.updateProgress(line)
              }
            },
          })
          const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
          const result: RunResult = {
            kind: 'sync',
            promptId,
            status: 'completed',
            elapsedMs: Date.now() - startedAt,
            media: items,
            summary: summarizeMedia(items),
          }
          return { status: 'completed', result: JSON.stringify(result) }
        } catch (error) {
          runtime.untrack(promptId)
          const message = error instanceof Error ? error.message : String(error)
          if (controller.signal.aborted) return { status: 'killed', detail: 'comfyui', result: message }
          return { status: 'failed', detail: 'comfyui', result: message }
        }
      })()
      return {
        cancel: () => { controller.abort() },
        done,
      }
    },
  }
  try {
    return jobs.start(spec)
  } catch (error) {
    // The prompt is already queued; a refused job (no live owner, registry
    // closing) must not leave it running unattended on the server.
    await client.cancelPrompt(promptId).catch(() => undefined)
    runtime.untrack(promptId)
    throw error
  }
}

const TOOL_TIMEOUT_MS = 3_600_000

/** The jobs registry for an async run, or a refusal naming the missing plugins. */
function requireJobs(ctx: Context, tool: string): JobRegistry {
  const jobs = ctx.get('jobs') as JobRegistry | undefined
  if (jobs === undefined) {
    throw new Error(`${tool}: background jobs unavailable — load @deepseek-ai/dsh-jobs-local and @deepseek-ai/dsh-tool-jobs`)
  }
  return jobs
}

/** The `timeout_ms` argument, clamped to 5 s – 1 h (bounds live here, not in
 * the schema: the host's schema subset has no minimum/maximum). */
function clampWait(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(3_600_000, Math.max(5_000, Math.round(value)))
}

/** Settle with `promise`, or reject as soon as the tool call is cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(new Error('cancelled')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function missing(args: Record<string, unknown>, name: string): boolean {
  return args[name] === undefined || args[name] === null
}

function requireOneOf(args: Record<string, unknown>, names: readonly string[]): string | undefined {
  const present = names.filter((name) => !missing(args, name))
  if (present.length === 0) return `exactly one of ${names.join(', ')} is required`
  if (present.length > 1) return `only one of ${names.join(', ')} may be given`
  return undefined
}

function buildWorkflow(args: Record<string, unknown>): { workflow: Record<string, { class_type: string; inputs: Record<string, unknown> }>; label: string } {
  const template = args.template
  if (typeof template === 'string') {
    const found = findTemplate(template)
    if (found === undefined) {
      throw new Error(`comfyui_run: unknown template "${template}" — use one of ${TEMPLATES.map((t) => t.id).join(', ')}`)
    }
    const workflow = cloneWorkflow(found.workflow)
    const inputs = args.inputs
    if (inputs !== undefined) {
      if (typeof inputs !== 'object' || inputs === null) {
        throw new Error('comfyui_run: inputs must be an object keyed by node id')
      }
      applyTemplateInputs(workflow, inputs as Record<string, Record<string, unknown>>)
    }
    return { workflow, label: `comfyui ${template}` }
  }
  const workflow = args.workflow
  if (typeof workflow !== 'object' || workflow === null) {
    throw new Error('comfyui_run: workflow must be an object')
  }
  const inputs = args.inputs
  if (inputs !== undefined) {
    if (typeof inputs !== 'object' || inputs === null) {
      throw new Error('comfyui_run: inputs must be an object keyed by node id')
    }
    applyTemplateInputs(workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, inputs as Record<string, Record<string, unknown>>)
  }
  return { workflow: workflow as Record<string, { class_type: string; inputs: Record<string, unknown> }>, label: 'comfyui custom workflow' }
}

function summarizeMedia(media: RunMediaItem[]): string {
  if (media.length === 0) return 'no media outputs'
  const images = media.filter((item) => item.kind === 'image').length
  const videos = media.filter((item) => item.kind === 'video').length
  const audio = media.filter((item) => item.kind === 'audio').length
  const others = media.length - images - videos - audio
  const parts: string[] = []
  if (images > 0) parts.push(`${images} image(s)`)
  if (videos > 0) parts.push(`${videos} video(s)`)
  if (audio > 0) parts.push(`${audio} audio file(s)`)
  if (others > 0) parts.push(`${others} other file(s)`)
  return parts.join(', ')
}

function renderRunResult(_args: unknown, value: unknown): unknown[] {
  const result = value as RunResult | BackgroundResult
  if (result.kind === 'background') {
    return [{
      type: 'text',
      text: `ComfyUI generation started in the background (job ${result.jobId}, prompt ${result.promptId}). Collect the result with job_output.`,
    }]
  }
  const lines = [
    `ComfyUI ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}`,
  ]
  for (const item of result.media) {
    lines.push(`  ${item.kind}: ${item.url}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Wait for a queued prompt and collect its media. Untracks the prompt when
 * the wait fails; an interrupted wait reports an interrupted result instead
 * of throwing.
 */
async function waitSync(
  runtime: ComfyUIRuntime,
  client: ComfyUIClient,
  promptId: string,
  config: Config,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<RunResult> {
  const startedAt = Date.now()
  try {
    const entry = await client.waitForCompletion({
      promptId,
      timeoutMs: timeoutMs ?? config.timeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      signal,
    })
    const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() })
    return {
      kind: 'sync',
      promptId,
      status: 'completed',
      elapsedMs: Date.now() - startedAt,
      media: items,
      summary: summarizeMedia(items),
    }
  } catch (error) {
    runtime.untrack(promptId)
    if (error instanceof ComfyUIInterruptedError) {
      return {
        kind: 'sync',
        promptId,
        status: 'interrupted',
        elapsedMs: Date.now() - startedAt,
        media: [],
        summary: 'interrupted before completion',
      }
    }
    throw error
  }
}

/**
 * Canonical output of `comfyui_run`, enforced by the host on every success and
 * rendered into the PTC SDK declarations, so `run_code` programs see
 * `jobId` / `media` instead of an opaque record.
 */
const RUN_RESULT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'sync' },
        promptId: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'interrupted'] },
        elapsedMs: { type: 'number' },
        media: { type: 'array', items: { type: 'object', description: 'One output: filename, subfolder, type, kind (image|video|audio|other), url, node, index.' } },
        summary: { type: 'string' },
      },
      required: ['kind', 'promptId', 'status', 'elapsedMs', 'media', 'summary'],
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'background' },
        jobId: { type: 'string', description: 'Background job id; collect with job_output.' },
        promptId: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['kind', 'jobId', 'promptId', 'label'],
    },
  ],
} as const

function runDefinition(runtime: ComfyUIRuntime, ctx: Context): ToolDefinition {
  return {
    name: 'comfyui_run',
    description: [
      'Submit a workflow to the configured ComfyUI server and return the generated media (images/videos).',
      'Provide exactly one of `workflow` (ComfyUI API-format object: node id → { class_type, inputs }) or `template` (built-in: txt2img | img2img | video).',
      'Use `inputs` to override node inputs by id, e.g. {"6": {"text": "a red cat"}} for the positive prompt in the templates.',
      'Templates: txt2img — 4 checkpoint, 5 EmptyLatentImage (width/height), 6 positive text, 7 negative text, 3 KSampler (seed/steps/cfg/denoise), 9 SaveImage. img2img — 10 LoadImage (image), 11 VAEEncode, 6 text, 3 KSampler (denoise). video — Wan 2.1, needs ComfyUI-WanVideoWrapper custom nodes (10 UNETLoader, 13 WanTextEncode, 14 WanImageToVideo, 15 KSampler, 17 SaveVideo).',
      'Inspect available node types with comfyui_object_info before hand-writing a workflow.',
      '`mode: sync` (default) waits and returns media URLs; `mode: async` starts a background job and returns a job id for job_output.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        workflow: { type: 'object', description: 'ComfyUI API-format workflow: node id → { class_type, inputs }. Alternative to `template`.' },
        template: { type: 'string', enum: ['txt2img', 'img2img', 'video'], description: 'Built-in workflow template id. Alternative to `workflow`.' },
        inputs: { type: 'object', description: 'Per-node input overrides keyed by node id, e.g. {"3": {"seed": 42, "steps": 30}, "6": {"text": "prompt"}}.' },
        mode: { type: 'string', enum: ['sync', 'async'], default: 'sync', description: 'sync waits and returns media; async returns a background job id.' },
        timeout_ms: { type: 'number', description: 'Generation wait budget in ms, 5000–3600000 (clamped; default from settings, 900000). Video needs minutes.' },
      },
      required: [],
    },
    output: {
      schema: RUN_RESULT_SCHEMA,
      render: renderRunResult,
      presentationMeta(_args, value) {
        const result = value as RunResult | BackgroundResult
        if (result.kind === 'background') {
          return { kind: 'background', jobId: result.jobId, promptId: result.promptId, label: result.label }
        }
        return {
          kind: 'sync',
          promptId: result.promptId,
          status: result.status,
          elapsedMs: result.elapsedMs,
          media: result.media,
          summary: result.summary,
        }
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const problem = requireOneOf(args, ['workflow', 'template'])
      if (problem !== undefined) throw new Error(`comfyui_run: ${problem}`)
      const mode = args.mode === undefined ? 'sync' : args.mode
      if (mode !== 'sync' && mode !== 'async') throw new Error(`comfyui_run: mode must be sync or async, got ${String(mode)}`)
      const config = runtime.getConfig()
      const apiKey = await runtime.getApiKey()
      const client = runtime.createClient(apiKey)
      const { workflow, label } = buildWorkflow(args)
      // Resolve the jobs service before queueing: a refused async call must
      // not leave a prompt running unattended on the server.
      const jobs = mode === 'async' ? requireJobs(ctx, 'comfyui_run') : undefined
      const promptId = await runtime.queue(workflow, { workflowName: label, source: 'tool' })
      const waitMs = clampWait(args.timeout_ms, config.timeoutMs)

      if (jobs !== undefined) {
        const jobId = await startBackgroundRun({
          jobs, runtime, client, config, promptId, label, waitMs, owner: exec.agent?.id,
        })
        const result: BackgroundResult = { kind: 'background', jobId, promptId, label }
        return result
      }

      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs)
      return result
    },
  }
}

interface FieldSummary {
  name: string
  type: string
  required: boolean
  default?: unknown
  options?: string[]
}

function summarizeFields(fields: Record<string, unknown> | undefined, required: boolean): FieldSummary[] {
  const out: FieldSummary[] = []
  for (const [name, spec] of Object.entries(fields ?? {})) {
    if (!Array.isArray(spec)) continue
    const [typeOrList, options] = spec as [unknown, unknown?]
    const optionsRecord = typeof options === 'object' && options !== null ? options as Record<string, unknown> : undefined
    const entry: FieldSummary = { name, type: 'unknown', required }
    if (Array.isArray(typeOrList)) {
      entry.type = 'enum'
      entry.options = (typeOrList as unknown[]).slice(0, 6).map(String)
    } else if (typeof typeOrList === 'string') {
      entry.type = typeOrList
    }
    if (optionsRecord !== undefined && optionsRecord.default !== undefined) {
      entry.default = optionsRecord.default
    }
    out.push(entry)
    if (out.length >= 14) break
  }
  return out
}

function objectInfoDefinition(runtime: ComfyUIRuntime): ToolDefinition {
  return {
    name: 'comfyui_object_info',
    description: 'List the node definitions the configured ComfyUI server supports (class types, required and optional inputs). Use it to build valid API-format workflows for comfyui_run. Optional `filter` narrows by class-name substring, e.g. "KSampler", "VAE", "LoadImage".',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Optional substring filter on node class names.' },
      },
      required: [],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value as { total: number; shown: number; nodes: Array<{ class_type: string; display_name?: string; description?: string }>; hint?: string }
        const lines = [`ComfyUI nodes: ${data.total} total, showing ${data.shown}`]
        for (const node of data.nodes) {
          lines.push(`- ${node.class_type}${node.display_name !== undefined ? ` (${node.display_name})` : ''}${node.description !== undefined && node.description !== '' ? `: ${node.description}` : ''}`)
        }
        if (data.hint !== undefined) lines.push(data.hint)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const client = runtime.createClient(await runtime.getApiKey())
      const raw = await abortable(client.objectInfo(), exec.signal)
      const entries = Object.entries(raw as Record<string, {
        display_name?: string
        description?: string
        input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> }
      }>)
      const filter = typeof args.filter === 'string' ? args.filter.trim().toLowerCase() : undefined
      const filtered = filter === undefined || filter === ''
        ? entries
        : entries.filter(([name]) => name.toLowerCase().includes(filter))
      const nodes = filtered.slice(0, 60).map(([classType, def]) => ({
        class_type: classType,
        // Omitted rather than assigned undefined: a key holding undefined makes the
        // whole result fail DSH's lossless-JSON validation. The render type already
        // declares display_name optional.
        ...(def.display_name !== undefined ? { display_name: def.display_name } : {}),
        description: (def.description ?? '').slice(0, 200),
        required: summarizeFields(def.input?.required, true),
        optional: summarizeFields(def.input?.optional, false),
      }))
      const hint = filtered.length > nodes.length
        ? `filter matched ${filtered.length} nodes, showing first ${nodes.length} — narrow the filter for more`
        : undefined
      return {
        total: entries.length,
        shown: nodes.length,
        filter: filter ?? null,
        // Omitted rather than assigned undefined, same reason as display_name.
        ...(hint !== undefined ? { hint } : {}),
        nodes,
      }
    },
  }
}

/** List and run saved workflows from the panel-managed library. */
function workflowDefinition(runtime: ComfyUIRuntime, ctx: Context): ToolDefinition {
  return {
    name: 'comfyui_workflow',
    description: [
      'List and run saved ComfyUI workflows from the plugin workflow library (runnable API workflows: API-format workflows extracted from a graph or pasted directly).',
      '`action: list` returns every runnable workflow with its id, name, description (what the workflow does), and input notes.',
      'It also lists workflows the user saved on the ComfyUI server (source graphs: UI graph format canvases). A graph may hold SEVERAL independent flows; each is extracted into its own runnable workflow in the panel (all/per component/main flow). A graph with no extracted workflow yet cannot run — tell the user to open the ComfyUI panel and extract it first.',
      '`action: run` runs one saved workflow by id — pass only the id plus parameter overrides; the plugin submits the saved workflow JSON itself (never copy the JSON into your reply). It waits for media by default; add `mode: "async"` to run in the background and collect the result with job_output.',
      '`action: get` returns one saved workflow\'s complete API-format JSON by id for inspection/diagnostics only — it consumes many tokens and is not the run path.',
      '`action: skill` reads the workflow skill pack SKILL.md by id, with its directory and file list; read it before running workflows that require their skill.',
      '`action: refresh` re-derives one saved workflow\'s parameter snapshot (options / numberKind / min/max/step) from the current node definitions and saves it back. Run it after the TTS-Audio-Suite voice library or node definitions changed: saved workflows snapshot their parameter options at save time, so a freshly added voice is not accepted by `action: run` until the snapshot catches up. It force-rescans the TTS voice library first, then updates only the fields derived from object_info — the parameter set (including user-added advanced parameters) is preserved. Returns `changed` with the parameter names that actually changed.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'run', 'get', 'refresh', 'skill'], description: 'list returns the workflow library; run executes one workflow by id (direct call to the saved JSON); get returns one workflow\'s full JSON for inspection; skill reads its SKILL.md, directory and file list; refresh re-derives one workflow\'s parameter snapshot from the current node definitions and saves it back.' },
        id: { type: 'string', description: 'Workflow id (required for action: run, get, skill and refresh).' },
        mode: { type: 'string', enum: ['sync', 'async'], description: 'run mode (default sync); async starts a background job and returns its id for job_output. Video/audio workflows should use async — generation takes minutes and sync may time out.' },
        timeout_ms: { type: 'number', description: 'Generation wait budget in ms, 5000–3600000 (clamped; default 900000 = 15 min). Video needs minutes; raise this for long videos.' },
        parameters: {
          type: 'object',
          description: 'Optional per-run values (action: list describes them), e.g. {"prompt":"a red cat","seed":42,"lora_1":{"on":false,"strength":0,"strengthTwo":null}}. LoRA accepts a partial object with only on:boolean, lora:string, strength:finite number, strengthTwo:finite number or null (inherit model strength). Supported fields merge into the authored row; unknown fields are refused. Empty object/string leaves it unchanged; unavailable authored files are preserved until changed explicitly. Omitted parameters use saved defaults; marked seeds randomize.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          workflows: { type: 'array', items: {
            type: 'object', properties: {
              id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' },
              parameters: { type: 'array', items: { type: 'object', properties: {
                name: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: ['string', 'number', 'boolean', 'lora'] },
                default: { oneOf: [
                  { type: 'string' }, { type: 'number' }, { type: 'boolean' },
                  { type: 'object', properties: {
                    on: { type: 'boolean' }, lora: { type: 'string' }, strength: { type: 'number' },
                    strengthTwo: { oneOf: [{ type: 'number' }, { type: 'null' }] },
                  }, required: ['on', 'lora', 'strength'], additionalProperties: true },
                ] },
                options: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
              }, required: ['name', 'type', 'default'], additionalProperties: true } },
            }, required: ['id', 'name', 'description'], additionalProperties: true,
          } },
        }, additionalProperties: true,
      },
      render(_args, value) {
        const data = value as {
          action: string
          env?: { baseUrl: string; comfyuiDirs: string[] }
          workflows?: Array<{ id: string; name: string; description: string; skill?: { summary: string; files: number; required: boolean }; parameters?: Array<{ name: string; label?: string; type?: string; default?: WorkflowParameter['default']; random?: boolean; numberKind?: 'int' | 'float'; options?: Array<string | number>; upload?: 'image' | 'video' | 'audio' | 'media'; subfolder?: string }> }>
          comfyuiWorkflows?: Array<{ name: string; extracted: boolean; derived: Array<{ libraryId: string; name: string }> }>
          loadArea?: { slots: number; loaded: number; items: Array<{ name: string; kind: string; source: string }> }
          result?: RunResult
          id?: string
          name?: string
          workflow?: unknown
          background?: BackgroundResult
          changed?: string[]
          parameterCount?: number
          skill?: { workflowName: string; summary: string; body: string; resourceBase: string; files: string[] }
        }
        if (data.action === 'skill') {
          const pack = data.skill
          if (pack === undefined) return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id} has no skill pack.` }]
          // Same framing the host uses for its own skills: a named block, the
          // resource base, then the body verbatim. The reference files stay on
          // disk until the body sends the model after one of them.
          const others = pack.files.filter((file) => file !== 'SKILL.md')
          return [{
            type: 'text',
            text: [
              `<skill_content name="${pack.workflowName}">`,
              '<skill_resources>',
              `Base directory for this skill: ${pack.resourceBase}`,
              others.length > 0
                ? `Files in this pack: ${others.join(', ')} — resolve them against the base directory and read one only when the instructions below point at it.`
                : 'This pack has no reference files.',
              '</skill_resources>',
              '',
              '<skill_instructions>',
              pack.body,
              '</skill_instructions>',
              '</skill_content>',
            ].join('\n'),
          }]
        }
        if (data.action === 'get') {
          return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}: ${JSON.stringify(data.workflow)}` }]
        }
        if (data.background !== undefined) {
          return [{ type: 'text', text: `ComfyUI workflow started in the background (job ${data.background.jobId}, prompt ${data.background.promptId}). Collect the result with job_output.` }]
        }
        if (data.action === 'refresh') {
          const changed = data.changed ?? []
          const changedText = changed.length > 0
            ? `Updated ${changed.length} parameter option lists / numeric metadata: ${changed.join(', ')}`
            : 'Options and numeric metadata already match the latest node definitions; no changes'
          return [{ type: 'text', text: `ComfyUI workflow ${data.name ?? data.id}: parameter snapshot refreshed (${data.parameterCount ?? 0} parameters preserved), ${changedText}` }]
        }
        if (data.action === 'list') {
          const lines: string[] = []
          const env = data.env
          if (env !== undefined) {
            // The model's local-env one-liner: the ComfyUI server address and
            // the user's ComfyUI install dirs, so it never has to ask where
            // files live (TTS-Audio-Suite voice library etc.).
            lines.push(`ComfyUI server: ${env.baseUrl}; local ComfyUI directories: ${env.comfyuiDirs.length > 0 ? env.comfyuiDirs.join('; ') : 'not configured (set comfyuiDirs in settings)'}`)
          }
          lines.push(`Saved ComfyUI workflows (${data.workflows?.length ?? 0}):`)
          for (const workflow of data.workflows ?? []) {
            lines.push(`- ${workflow.id} — ${workflow.name}${workflow.description !== '' ? `: ${workflow.description}` : ''}`)
            const skill = workflow.skill
            if (skill !== undefined) {
              const extra = skill.files > 1 ? `, plus ${skill.files - 1} reference files` : ''
              lines.push(`  Skill pack${skill.required ? ' (required before running)' : ''}: ${skill.summary}${extra} — before running, call action: skill { id: "${workflow.id}" }`)
            }
            for (const param of workflow.parameters ?? []) {
              const label = param.label ?? param.name
              const def = param.default === undefined ? '' : `, default ${JSON.stringify(param.default)}`
              const options = Array.isArray(param.options) && param.options.length > 0 ? `, options: ${param.options.join(' / ')}` : ''
              const upload = param.upload !== undefined
                ? `, upload type: ${param.upload}${param.upload === 'media' ? `(${param.subfolder ?? ''}/, empty = remove this reference slot)` : ''}`
                : ''
              lines.push(`  ${param.name}(${label}${param.random === true ? ', random' : ''}${def}${options}${upload})`)
              if (param.type === 'lora') lines.push('    LoRA partial object: {on?:boolean, lora?:string, strength?:finite number, strengthTwo?:finite number|null}; null inherits model strength. Supported fields merge; empty overrides keep authored values; unknown fields are refused. Choose known files when changing; unchanged authored unavailable files are preserved.')
            }
          }
          const loadArea = data.loadArea
          if (loadArea !== undefined && loadArea.slots > 0) {
            lines.push(`User load area (${loadArea.slots} slots, ${loadArea.loaded} loaded; unset loader parameters consume them in order):`)
            for (const [index, item] of loadArea.items.entries()) {
              lines.push(`  ${index + 1}. ${item.name}(${item.kind})`)
            }
          }
          const comfyui = data.comfyuiWorkflows ?? []
          if (comfyui.length > 0) {
            lines.push(`Graph workflows saved on ComfyUI (${comfyui.length}, UI graph format, not directly runnable):`)
            for (const workflow of comfyui) {
              if (workflow.extracted) {
                lines.push(`- ${workflow.name} — extracted ${workflow.derived.length} runnable workflows: ${workflow.derived.map((d) => `${d.name}(${d.libraryId})`).join(', ')}`)
              } else {
                lines.push(`- ${workflow.name} — not extracted: ask the user to Extract it in the ComfyUI panel first (all/per component/main flow)`)
              }
            }
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        const result = data.result
        if (result === undefined) return [{ type: 'text', text: 'ComfyUI workflow run returned no result.' }]
        const lines = [`ComfyUI workflow ${result.status} (prompt ${result.promptId}) in ${result.elapsedMs} ms — ${summarizeMedia(result.media)}`]
        for (const item of result.media) lines.push(`  ${item.kind}: ${item.url}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const action = args.action
      if (action !== 'list' && action !== 'run' && action !== 'get' && action !== 'refresh' && action !== 'skill') {
        throw new Error(`comfyui_workflow: action must be list, run, skill, get, or refresh, got ${String(action)}`)
      }
      if (action === 'list') {
        const [workflows, comfyui, slots] = await Promise.all([
          runtime.listWorkflows(),
          runtime.listComfyWorkflows().catch(() => []),
          runtime.loadSlots().catch(() => [] as LoadSlot[]),
        ])
        // What the user currently has loaded in the panel's load area. Unset
        // loader parameters take these files in slot order, so the model can
        // see how many references a run will pick up without asking.
        const loaded = slots.filter((slot): slot is NonNullable<LoadSlot> => slot !== null)
        // Rung one of the skill-pack disclosure ladder: a workflow that has a
        // pack contributes ONE summary line here, not its body. The model
        // reaches for `action: skill` only after this listing points it at a
        // specific workflow, so an unused pack costs nothing.
        const packs = new Map<string, { summary: string; files: number; required: boolean }>()
        await Promise.all(workflows
          .filter((workflow) => workflow.skillDir !== undefined && workflow.skillDir !== '')
          .map(async (workflow) => {
            const pack = await runtime.skillPacks.infoFor(workflow).catch(() => undefined)
            if (pack === undefined) return
            packs.set(workflow.id, {
              summary: pack.summary !== '' ? pack.summary : `${workflow.name} — instructions for use`,
              files: pack.files.length,
              required: pack.required,
            })
          }))
        return {
          action: 'list',
          // Local environment the model can rely on: the ComfyUI server
          // address and the user's ComfyUI install dirs (configured in the
          // settings page comfyuiDirs). Fresh on every call, so config
          // changes show up without restarting DSH.
          env: {
            baseUrl: runtime.getConfig().baseUrl,
            comfyuiDirs: runtime.getConfig().comfyuiDirs,
          },
          loadArea: {
            slots: slots.length,
            loaded: loaded.length,
            items: loaded.map(({ name, kind, source }) => ({ name, kind, source })),
          },
          workflows: workflows.map(({ id, name, description, parameters, updatedAt }) => ({
            id,
            name,
            description,
            ...(packs.has(id) ? { skill: packs.get(id)! } : {}),
            parameters: (parameters ?? []).map(({ name: pname, label, type, default: def, random, numberKind, options, upload }) => {
              // DSH validates tool output as lossless JSON: JSON.stringify drops
              // undefined keys, so omit optional fields instead of passing undefined.
              const entry: Record<string, unknown> = { name: pname }
              if (label !== undefined) entry.label = label
              if (type !== undefined) entry.type = type
              if (def !== undefined) entry.default = def
              if (random !== undefined) entry.random = random
              // Tells the model whether decimals are accepted; absent means the
              // node's declared type is unknown and a float is safe.
              if (numberKind !== undefined) entry.numberKind = numberKind
              if (options !== undefined) entry.options = options
              if (upload !== undefined) entry.upload = upload
              return entry
            }),
            updatedAt,
          })),
          comfyuiWorkflows: comfyui.map(({ name, extracted, derived }) => ({ name, extracted, derived })),
        }
      }
      const id = args.id
      if (typeof id !== 'string' || id === '') {
        throw new Error('comfyui_workflow: id is required for action: run, get, refresh and skill')
      }
      const saved = await runtime.getWorkflow(id)
      if (saved === undefined) {
        throw new Error(`comfyui_workflow: workflow "${id}" not found — run action: list first`)
      }
      if (action === 'get') {
        return {
          action: 'get',
          id: saved.id,
          name: saved.name,
          description: saved.description,
          parameters: saved.parameters ?? [],
          workflow: saved.workflow,
        }
      }
      if (action === 'skill') {
        const pack = await runtime.skillPacks.load(saved.id)
        if (!pack.ok) {
          throw new Error(`comfyui_workflow: ${pack.error}`)
        }
        // Reading the pack is what opens the `requireSkill` gate below.
        markSkillPackRead(exec.agent, saved.id)
        return {
          action: 'skill',
          id: saved.id,
          name: saved.name,
          skill: {
            workflowName: pack.value.workflowName,
            summary: pack.value.summary,
            body: pack.value.body,
            resourceBase: pack.value.resourceBase,
            files: pack.value.files,
          },
        }
      }
      if (action === 'refresh') {
        // The library snapshot is captured at save time and never re-reads
        // object_info, so a voice library that grew since then would reject
        // the new voice at run time. Force the TTS rescan first (the object_info
        // COMBO does not self-heal), then re-derive the derived fields only.
        await abortable(runtime.refreshVoiceLibrary(), exec.signal)
        const client = runtime.createClient(await runtime.getApiKey())
        const objectInfo = await abortable(client.objectInfo(), exec.signal).catch((error: unknown) => {
          if (exec.signal.aborted) throw error
          return undefined
        })
        const { parameters, changed } = refreshParameterMetadata(
          saved.parameters ?? [],
          objectInfo,
          saved.workflow,
        )
        const result = await runtime.saveWorkflow({
          id: saved.id,
          name: saved.name,
          description: saved.description,
          workflow: saved.workflow,
          parameters,
          source: saved.source,
          comfyuiFile: saved.comfyuiFile,
          tags: saved.tags,
        })
        if (!result.ok) {
          throw new Error(`comfyui_workflow: refresh failed: ${result.error}`)
        }
        return {
          action: 'refresh',
          id: saved.id,
          name: saved.name,
          parameterCount: parameters.length,
          changed,
        }
      }
      // The read-before-run gate: workflows the user marked `requireSkill` refuse to run
      // until this session has actually loaded their pack. The reminder in the
      // listing is advisory; this is the part that holds.
      if (saved.requireSkill === true && saved.skillDir !== undefined && !hasReadSkillPack(exec.agent, saved.id)) {
        throw new Error(`comfyui_workflow: workflow "${saved.name}" requires reading its skill pack before running — call action: skill { id: "${saved.id}" } first, then run.`)
      }
      const config = runtime.getConfig()
      const client = runtime.createClient(await runtime.getApiKey())
      const values = typeof args.parameters === 'object' && args.parameters !== null
        ? (args.parameters as Record<string, unknown>)
        : {}
      // Validate before queueing: a refused call must not leave a prompt behind.
      const mode = args.mode === undefined ? 'sync' : args.mode
      if (mode !== 'sync' && mode !== 'async') {
        throw new Error(`comfyui_workflow: mode must be sync or async, got ${String(mode)}`)
      }
      const jobs = mode === 'async' ? requireJobs(ctx, 'comfyui_workflow') : undefined
      const promptId = await runtime.queue(saved.workflow, {
        workflowName: saved.name,
        workflowId: saved.id,
        source: 'workflow-tool',
        parameters: saved.parameters,
        values,
      })
      const waitMs = clampWait(args.timeout_ms, config.timeoutMs)
      if (jobs !== undefined) {
        const jobId = await startBackgroundRun({
          jobs, runtime, client, config, promptId, label: saved.name, waitMs, owner: exec.agent?.id,
        })
        return { action: 'run', id, workflowName: saved.name, background: { kind: 'background', jobId, promptId, label: saved.name } }
      }
      const result = await waitSync(runtime, client, promptId, config, exec.signal, waitMs)
      return { action: 'run', id, workflowName: saved.name, result }
    },
  }
}

/**
 * `comfyui_skill`: read and write one workflow's skill pack.
 *
 * The pack is documentation the agent is expected to consult before running a
 * workflow (`comfyui_workflow action: skill`), and this tool is the other half:
 * the agent can also author it — record a pitfall it just hit, add a style
 * reference, lay out its own folders — with the same validation, size caps, and
 * path containment the panel goes through.
 *
 * Destroying a pack is deliberately absent. The files are hand-written by the
 * user and have no other copy, so removing the whole thing stays a panel
 * gesture behind an explicit confirmation; the agent can delete a file it owns
 * but cannot wipe the directory.
 */
function skillDefinition(runtime: ComfyUIRuntime): ToolDefinition {
  return {
    name: 'comfyui_skill',
    description: [
      "Read and write one workflow's skill pack: the SKILL.md the agent reads before running that workflow, plus its reference files, scripts, templates and assets.",
      '`action: list` returns the pack listing (files, sub-directories, byte sizes) and its absolute directory.',
      '`action: read` returns one file (path relative to the pack, e.g. `references/styles.md`); reading `SKILL.md` also satisfies the read-before-run gate that blocks `comfyui_workflow action: run` for workflows marked required.',
      '`action: write` creates or overwrites one file (`content`); pass `summary` alongside when writing SKILL.md to set the one-line summary the workflow listing shows. `action: append` adds to the end of an existing file instead — the right choice for recording a newly discovered pitfall without rewriting the document.',
      '`action: mkdir` creates a sub-directory, `action: rename` moves a file within the pack, `action: delete` removes one file (SKILL.md cannot be renamed or deleted).',
      '`action: enable` attaches a pack to a workflow that has none (seeding SKILL.md), and `action: require` toggles whether running that workflow demands the pack be read first.',
      'Write documentation the next agent run will need: when to use the workflow, which parameter values matter, what fails. Keep SKILL.md short and put bulk material in separate files — SKILL.md is loaded whole, the other files only when it points at them.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'read', 'write', 'append', 'mkdir', 'rename', 'delete', 'enable', 'require'],
          description: 'list the pack; read/write/append/rename/delete one file; mkdir a sub-directory; enable a pack on a workflow; require toggles the read-before-run gate.',
        },
        workflow_id: { type: 'string', description: 'Workflow id from comfyui_workflow action: list.' },
        path: { type: 'string', description: 'Pack-relative file path for read/write/append/rename/delete, e.g. "SKILL.md" or "references/styles.md". One level of sub-directory only.' },
        content: { type: 'string', description: 'File text for write and append.' },
        summary: { type: 'string', description: 'One-line summary stored in SKILL.md frontmatter; this is the line the workflow listing shows, so make it say when to use the workflow.' },
        to: { type: 'string', description: 'New path for rename (a bare name keeps the current directory).' },
        name: { type: 'string', description: 'Sub-directory name for mkdir (letters, digits, CJK, underscore, dash).' },
        required: { type: 'boolean', description: 'For action: require — true refuses to run the workflow until the pack has been read in this session.' },
      },
      required: ['action', 'workflow_id'],
    },
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        const data = value as {
          action: string
          workflowName?: string
          path?: string
          content?: string
          truncated?: boolean
          dir?: string
          summary?: string
          files?: Array<{ path: string; size: number }>
          dirs?: string[]
          required?: boolean
        }
        if (data.action === 'read') {
          return [{ type: 'text', text: `${data.path} (${data.workflowName}):\n${data.content ?? ''}${data.truncated === true ? '\n… (file too large; truncated)' : ''}` }]
        }
        const lines: string[] = []
        if (data.action === 'list') {
          lines.push(`Skill pack ${data.workflowName}(${data.dir})${data.required === true ? ' — required before running' : ''}`)
          if (data.summary !== undefined && data.summary !== '') lines.push(`Summary: ${data.summary}`)
          for (const file of data.files ?? []) lines.push(`  ${file.path} (${file.size} B)`)
          const empty = (data.dirs ?? []).filter((dir) => !(data.files ?? []).some((file) => file.path.startsWith(`${dir}/`)))
          if (empty.length > 0) lines.push(`  Empty directories: ${empty.map((dir) => `${dir}/`).join(', ')}`)
          return [{ type: 'text', text: lines.join('\n') }]
        }
        lines.push(`Skill pack ${data.workflowName} updated (${data.action}${data.path !== undefined ? ` ${data.path}` : ''})`)
        for (const file of data.files ?? []) lines.push(`  ${file.path} (${file.size} B)`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta(_args, value) {
        return value
      },
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const action = args.action
      const id = args.workflow_id
      if (typeof id !== 'string' || id === '') {
        throw new Error('comfyui_skill: workflow_id is required')
      }
      const saved = await runtime.getWorkflow(id)
      if (saved === undefined) {
        throw new Error(`comfyui_skill: workflow "${id}" not found — run comfyui_workflow action: list first`)
      }
      const path = typeof args.path === 'string' ? args.path : ''
      const content = typeof args.content === 'string' ? args.content : ''

      const listing = async (label: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const pack = await runtime.skillPacks.info(id)
        if (pack === undefined) throw new Error(`comfyui_skill: workflow "${saved.name}" has no skill pack — attach one with action: enable first`)
        return {
          action: label,
          workflowId: id,
          workflowName: saved.name,
          dir: pack.dir,
          summary: pack.summary,
          required: pack.required,
          files: pack.files.map(({ path: file, size }) => ({ path: file, size })),
          dirs: pack.dirs,
          ...extra,
        }
      }

      if (action === 'enable') {
        const result = await runtime.skillPacks.enable(id)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('enable')
      }
      if (action === 'list') return listing('list')
      if (action === 'require') {
        const result = await runtime.skillPacks.setRequired(id, args.required === true)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('require')
      }
      if (action === 'read') {
        if (path === '') throw new Error('comfyui_skill: path is required for action: read')
        const file = await runtime.skillPacks.readFile(id, path)
        if (!file.ok) throw new Error(`comfyui_skill: ${file.error}`)
        // Reading the main document is the same gesture `comfyui_workflow
        // action: skill` performs, so it opens the run gate too.
        if (path === SKILL_MAIN) markSkillPackRead(exec.agent, id)
        const truncated = file.value.length > MAX_TOOL_READ_CHARS
        return {
          action: 'read',
          workflowId: id,
          workflowName: saved.name,
          path,
          content: truncated ? file.value.slice(0, MAX_TOOL_READ_CHARS) : file.value,
          truncated,
        }
      }
      if (action === 'write' || action === 'append') {
        if (path === '') throw new Error(`comfyui_skill: path is required for action: ${action}`)
        let text = content
        if (action === 'append') {
          const existing = await runtime.skillPacks.readFile(id, path)
          const before = existing.ok ? existing.value : ''
          text = before === '' ? content : `${before.replace(/\s*$/, '')}\n\n${content}`
        }
        const summary = typeof args.summary === 'string' ? args.summary : undefined
        const result = path === SKILL_MAIN && summary !== undefined
          ? await runtime.skillPacks.writeFile(id, path, joinFrontmatter(summary, text))
          : await runtime.skillPacks.writeFile(id, path, text)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing(action, { path })
      }
      if (action === 'mkdir') {
        const name = typeof args.name === 'string' ? args.name : ''
        const result = await runtime.skillPacks.makeDir(id, name)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('mkdir', { path: `${name}/` })
      }
      if (action === 'rename') {
        const to = typeof args.to === 'string' ? args.to : ''
        if (path === '' || to === '') throw new Error('comfyui_skill: path and to are required for action: rename')
        const bucket = path.includes('/') ? `${path.split('/')[0] ?? ''}/` : ''
        const target = to.includes('/') ? to : `${bucket}${to}`
        const result = await runtime.skillPacks.renameFile(id, path, target)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('rename', { path: target })
      }
      if (action === 'delete') {
        if (path === '') throw new Error('comfyui_skill: path is required for action: delete')
        const result = await runtime.skillPacks.deleteFile(id, path)
        if (!result.ok) throw new Error(`comfyui_skill: ${result.error}`)
        return listing('delete', { path })
      }
      throw new Error(`comfyui_skill: unknown action ${String(action)}`)
    },
  }
}

/** Register the plugin tools; returns disposers. */
export function registerComfyUITools(ctx: Context, runtime: ComfyUIRuntime): Array<() => void> {
  const tools = (ctx as unknown as { tools: { register(definition: ToolDefinition): () => void } }).tools
  const disposers: Array<() => void> = []
  disposers.push(tools.register(runDefinition(runtime, ctx)))
  disposers.push(tools.register(objectInfoDefinition(runtime)))
  disposers.push(tools.register(workflowDefinition(runtime, ctx)))
  disposers.push(tools.register(skillDefinition(runtime)))
  return disposers
}
