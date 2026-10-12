/**
 * Convert a ComfyUI UI-graph workflow (the format the ComfyUI frontend saves
 * to the server via /api/userdata) into the API format accepted by POST
 * /prompt. Modeled on the frontend's convertToApiFormat: input links become
 * [nodeId, slot] references, named widgets map explicitly to API inputs;
 * legacy widgets_values use graph widget order with object_info fallback
 * (control_after_generate is the extra seed widget), and
 * Reroute / bypassed (mode 4) nodes are skipped with their links rewired.
 * Nodes the conversion cannot represent fail loudly with the offending type.
 */
import { isVirtualNodeType, normalizeLinks, resolveVirtualLinks, type GraphLink } from './graph.js'

export interface ApiWorkflow {
  [nodeId: string]: { class_type: string; inputs: Record<string, unknown> }
}

export type ConvertResult =
  | { ok: true; workflow: ApiWorkflow; warnings: string[] }
  | { ok: false; error: string }

interface GraphNode {
  id: number
  type: string
  mode?: number
  inputs?: Array<{ name: string; link: number | null; widget?: { name?: string } }>
  outputs?: Array<{ links: Array<number | null> }>
  widgets_values?: unknown
  widgets_values_named?: Record<string, unknown>
}

/** Node types that exist only in the UI and carry no data flow. */
const UI_ONLY = new Set(['Note', 'StickyNote', 'Reroute', 'Fast Groups Bypasser (rgthree)'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Never assign prototype-mutating/reserved names to plain API dictionaries. */
function safeInputName(name: string): boolean {
  return name !== '__proto__' && name !== 'constructor' && name !== 'prototype'
}

function uiOnlyWidgetName(name: string): boolean {
  return name === 'control_after_generate' || /^divider(?:#\d+)?$/.test(name)
    || name === 'PowerLoraLoaderHeaderWidget' || name === '➕ Add Lora'
}

function isWidgetSpec(typeSpec: unknown, options: Record<string, unknown> | undefined): boolean {
  return (
    typeof typeSpec === 'string' &&
    (typeSpec === 'INT' || typeSpec === 'FLOAT' || typeSpec === 'STRING' || typeSpec === 'BOOLEAN')
  ) || Array.isArray(typeSpec) || (options?.widget as { name?: unknown } | undefined)?.name !== undefined
}

/** The object_info input spec for one input name of a node class, if declared. */
function inputSpec(
  objectInfo: Record<string, unknown>,
  classType: string,
  name: string,
): unknown {
  const def = objectInfo[classType]
  const input = isObject(def) && isObject(def.input) ? def.input : undefined
  if (input === undefined) return undefined
  for (const group of ['required', 'optional'] as const) {
    const fields = isObject(input[group]) ? input[group] : {}
    if (Object.hasOwn(fields, name)) return fields[name]
  }
  return undefined
}

/** Option keys a COMFY_DYNAMICCOMBO_V3 spec declares, or undefined when unreadable. */
function dynamicComboKeys(spec: unknown[]): string[] | undefined {
  const options = isObject(spec[1]) ? spec[1].options : undefined
  if (!Array.isArray(options)) return undefined
  const keys = options
    .map((option) => (isObject(option) ? option.key : undefined))
    .filter((key): key is string => typeof key === 'string')
  return keys.length > 0 ? keys : undefined
}

/**
 * Flatten DynamicCombo values that 0.2.0–0.5.1 extraction wrapped as
 * `{ key, inputs: { sub: value } }` back into the flat API shape
 * (`master: key`, `master.sub: value`, recursively). Library entries saved by
 * those versions still carry the wrapped shape; normalizing at queue time
 * heals them without asking users to re-extract (Issue #10). Returns the same
 * object when nothing needed flattening.
 */
export function flattenDynamicCombos<W extends Record<string, { class_type: string; inputs: Record<string, unknown> }>>(
  workflow: W,
): W {
  const isWrapped = (value: unknown): value is { key: string; inputs: Record<string, unknown> } =>
    isObject(value) && typeof value.key === 'string' && isObject(value.inputs)
    && Object.keys(value).every((k) => k === 'key' || k === 'inputs')
  const flatten = (prefix: string, value: unknown, into: Record<string, unknown>): void => {
    if (!isWrapped(value)) {
      into[prefix] = value
      return
    }
    into[prefix] = value.key
    for (const [sub, subValue] of Object.entries(value.inputs)) flatten(`${prefix}.${sub}`, subValue, into)
  }
  let changed = false
  const out: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
  for (const [id, node] of Object.entries(workflow)) {
    if (!Object.values(node.inputs).some(isWrapped)) {
      out[id] = node
      continue
    }
    changed = true
    const inputs: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(node.inputs)) flatten(name, value, inputs)
    out[id] = { ...node, inputs }
  }
  return changed ? (out as W) : workflow
}

/**
 * Derive the ordered widget-input names for one node. The graph's own input
 * array is the source of truth — widgets_values is stored in UI widget order,
 * which includes dynamic sub-widgets (e.g. TextGenerate's sampling_mode.*) and
 * still holds values for linked widget inputs. object_info only supplies the
 * control_after_generate combo that follows an INT widget with that option.
 */
function widgetNamesFor(
  classType: string,
  objectInfo: Record<string, unknown>,
  node: GraphNode,
): string[] {
  const names: string[] = []
  const addUnique = (name: string): void => {
    if (!names.includes(name)) names.push(name)
  }

  for (const entry of node.inputs ?? []) {
    const name = entry.widget?.name
    if (typeof name !== 'string' || name === '') continue
    addUnique(name)
    const spec = inputSpec(objectInfo, classType, entry.name)
    const typeSpec = Array.isArray(spec) ? spec[0] : undefined
    const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined
    // ComfyUI's frontend renders a control_after_generate dropdown for INT
    // widgets named "seed" even when object_info does not declare it (observed
    // on TTS-Audio-Suite's UnifiedTTSTextNode / UnifiedVoiceDesignerNode). The
    // dropdown's value occupies one slot in widgets_values, so a placeholder
    // name is required to keep the zip aligned with the following widgets.
    if (typeSpec === 'INT' && options?.control_after_generate !== false) {
      const seedLike = name === 'seed' || /(^|_|-)(seed|noise_seed)$/i.test(name)
      if (options?.control_after_generate === true || seedLike) {
        addUnique('control_after_generate')
      }
    }
  }

  // DynamicCombo V3 widgets serialize in UI order: the master combo's value
  // comes BEFORE its sub-widgets, while the graph's inputs array lists the
  // sub-widgets first. Reorder the master combo ahead of its `prefix.*`
  // sub-widgets so the zip below aligns with widgets_values.
  const dynamicCombos = (node.inputs ?? [])
    .map((entry) => entry.widget?.name)
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .filter((name) => {
      const spec = inputSpec(objectInfo, classType, name)
      return Array.isArray(spec) && spec[0] === 'COMFY_DYNAMICCOMBO_V3'
    })
  if (dynamicCombos.length > 0) {
    const reordered: string[] = []
    for (const name of names) {
      const master = dynamicCombos.find((prefix) => name.startsWith(`${prefix}.`))
      if (master !== undefined) {
        if (!reordered.includes(master)) reordered.push(master)
        reordered.push(name)
        continue
      }
      if (!dynamicCombos.includes(name) || !names.some((other) => other.startsWith(`${name}.`))) {
        reordered.push(name)
      }
    }
    names.splice(0, names.length, ...reordered)
  }

  // Fallback: object_info-declared widget inputs the graph did not list.
  const def = objectInfo[classType]
  const input = isObject(def) && isObject(def.input) ? def.input : undefined
  if (input !== undefined) {
    const collect = (group: 'required' | 'optional'): void => {
      const fields = isObject(input![group]) ? input![group] : {}
      for (const [key, spec] of Object.entries(fields)) {
        if (spec === null || spec === undefined) continue
        const [typeSpec, options] = Array.isArray(spec)
          ? [spec[0], isObject(spec[1]) ? spec[1] : undefined]
          : [undefined, undefined]
        if (!isWidgetSpec(typeSpec, options)) continue
        addUnique((options?.widget as { name?: string } | undefined)?.name ?? key)
      }
    }
    collect('required')
    collect('optional')
  }
  return names
}

/** Resolve a link to its effective origin, following Reroute and bypassed nodes. */
function resolveOutput(
  linkId: number,
  links: Map<number, GraphLink>,
  nodesById: Map<number, GraphNode>,
  objectInfo: Record<string, unknown>,
  warnings: string[],
  dropReasons?: Map<string, string>,
): [string, number] | unknown | 'missing' {
  const link = links.get(linkId)
  if (link === undefined) return 'missing'
  return resolveOrigin(link[1], link[2], links, nodesById, objectInfo, warnings, dropReasons)
}

function resolveOrigin(
  nodeId: number,
  slot: number,
  links: Map<number, GraphLink>,
  nodesById: Map<number, GraphNode>,
  objectInfo: Record<string, unknown>,
  warnings: string[],
  dropReasons?: Map<string, string>,
): [string, number] | unknown | 'missing' {
  const node = nodesById.get(nodeId)
  if (node === undefined) return 'missing'

  // Reroute: the output mirrors the node's input.
  if (node.type === 'Reroute') {
    const inputLink = (node.inputs ?? []).find((entry) => entry.link !== null)?.link
    if (inputLink === undefined || inputLink === null) {
      dropReasons?.set(`${nodeId}:${slot}`, `Исходный узел ${node.type} (id ${nodeId}): вход сквозного соединения не подключён`)
      return 'missing'
    }
    return resolveOutput(inputLink, links, nodesById, objectInfo, warnings, dropReasons)
  }

  // Bypassed nodes act as pass-throughs: the output follows the first wired input.
  if (node.mode === 4) {
    const inputLink = (node.inputs ?? []).find((entry) => entry.link !== null)?.link
    if (inputLink === undefined || inputLink === null) {
      dropReasons?.set(`${nodeId}:${slot}`, `Исходный узел ${node.type} (id ${nodeId}, обход включён): вход сквозного соединения не подключён`)
      return 'missing'
    }
    return resolveOutput(inputLink, links, nodesById, objectInfo, warnings, dropReasons)
  }

  // Unregistered node types: a UI-only value source inlines its first widget;
  // anything else wired into the chain is a hard conversion error.
  if (objectInfo[node.type] === undefined) {
    const value = Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined
    if (value === undefined) {
      dropReasons?.set(`${nodeId}:${slot}`, `Исходный узел ${node.type} (id ${nodeId}) — незарегистрированный узел интерфейса без встроенного значения`)
      return 'missing'
    }
    return value
  }

  // Node id references must be strings: the server keys prompts by string id
  // and does a direct dict lookup (execution.py validate_inputs). Slots beyond
  // the server-side output count are graph artifacts (e.g. SaveImage saving an
  // extra UI output) — drop the reference and surface a warning.
  const outputCount = Array.isArray((objectInfo[node.type] as { output?: unknown[] } | undefined)?.output)
    ? (objectInfo[node.type] as { output?: unknown[] }).output!.length
    : undefined
  if (outputCount !== undefined && slot >= outputCount) {
    dropReasons?.set(
      `${nodeId}:${slot}`,
      `Исходный узел ${node.type} (id ${nodeId}), выход ${slot} отсутствует на сервере (число выходов в API: ${outputCount})`,
    )
    warnings.push(`Узел ${node.type}: выход ${slot} отсутствует на сервере; соответствующие связи удалены`)
    return 'missing'
  }
  return [String(nodeId), slot]
}

/**
 * Convert a UI-graph workflow (or one extracted component of it) to API
 * format using the live node definitions.
 * @param graph - parsed ComfyUI UI graph (v0.4 format).
 * @param objectInfo - the server's `/object_info` response.
 * @param options - `includeNodeIds` restricts conversion to one connected
 *   component (extraction); link resolution still uses the full graph, which
 *   is safe because components never share links.
 */
export function convertGraphToApi(
  graph: unknown,
  objectInfo: Record<string, unknown>,
  options?: { includeNodeIds?: Set<number> },
): ConvertResult {
  if (!isObject(graph)) return { ok: false, error: 'Это не граф ComfyUI (нет nodes/links)' }
  const rawNodes = graph.nodes
  const rawLinks = graph.links
  if (!Array.isArray(rawNodes)) return { ok: false, error: 'Отсутствует массив nodes' }
  if (!Array.isArray(rawLinks)) return { ok: false, error: 'Отсутствует массив links' }

  const nodes = rawNodes.filter(isObject).map((raw) => {
    const id = typeof raw.id === 'number' ? raw.id : Number(raw.id)
    const inputs = Array.isArray(raw.inputs) ? raw.inputs.filter(isObject).map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      link: typeof entry.link === 'number' ? entry.link : null,
      widget: isObject(entry.widget) ? entry.widget : undefined,
    })) : []
    const outputs = Array.isArray(raw.outputs) ? raw.outputs.filter(isObject).map((entry) => ({
      links: Array.isArray(entry.links) ? entry.links.filter((link): link is number => typeof link === 'number') : [],
    })) : []
    return {
      id,
      type: typeof raw.type === 'string' ? raw.type : '',
      mode: typeof raw.mode === 'number' ? raw.mode : 0,
      inputs,
      outputs,
      widgets_values: Array.isArray(raw.widgets_values) || isObject(raw.widgets_values)
        ? raw.widgets_values
        : undefined,
      widgets_values_named: isObject(raw.widgets_values_named) ? raw.widgets_values_named : undefined,
    }
  })

  const links = new Map<number, GraphLink>()
  // normalizeLinks accepts both the legacy positional rows and the v0.4
  // frontend's object entries; anything unreadable is skipped, exactly like
  // the old array-only guard did.
  // Set/Get wireless links and rgthree mode relays are rewired out before
  // anything resolves a link (Issue #8), shared with analyzeGraph.
  for (const link of resolveVirtualLinks(rawNodes, normalizeLinks(rawLinks))) links.set(link[0], link)
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const included = options?.includeNodeIds
  const candidates = included !== undefined ? nodes.filter((node) => included.has(node.id)) : nodes
  const hasUsedOutput = (node: GraphNode): boolean =>
    (node.outputs ?? []).some((output) => output.links.some((linkId) => {
      if (linkId === null) return false
      const link = links.get(linkId)
      return link !== undefined && nodesById.get(link[3]) !== undefined
    }))

  const workflow: ApiWorkflow = {}
  const warnings: string[] = []
  // Inputs that ARE wired in the source graph but whose connection was dropped
  // during conversion (usually because the upstream slot does not exist on the
  // server): key `${targetNodeId}.${inputName}` -> drop reasons.
  const brokenInputs = new Map<string, string[]>()
  const dropReasons = new Map<string, string>()
  for (const node of candidates) {
    if (node.type === '' || UI_ONLY.has(node.type) || isVirtualNodeType(node.type)) continue
    if (node.mode === 4) continue
    if (node.type.startsWith('workflow')) {
      return { ok: false, error: `Найден узел подграфа "${node.type}"; преобразование пока не поддерживается` }
    }
    if (objectInfo[node.type] === undefined) {
      if (!hasUsedOutput(node) || node.type.startsWith('Primitive')) continue
      return { ok: false, error: `Найден незарегистрированный узел интерфейса "${node.type}"; преобразование невозможно` }
    }

    const inputs: Record<string, unknown> = {}
    for (const entry of node.inputs ?? []) {
      if (!safeInputName(entry.name)) continue
      if (entry.link === undefined || entry.link === null) continue
      const resolved = resolveOutput(entry.link, links, nodesById, objectInfo, warnings, dropReasons)
      if (resolved !== 'missing') {
        inputs[entry.name] = resolved
      } else {
        const link = links.get(entry.link)
        const srcKey = link !== undefined ? `${link[1]}:${link[2]}` : undefined
        const hint = srcKey !== undefined && dropReasons.has(srcKey)
          ? dropReasons.get(srcKey)!
          : 'Не удалось разрешить связь (граф повреждён или источник отключён)'
        const key = `${node.id}.${entry.name}`
        const arr = brokenInputs.get(key) ?? []
        arr.push(hint)
        brokenInputs.set(key, arr)
      }
    }
    const values = node.widgets_values
    if (node.widgets_values_named !== undefined) {
      // A named map is authoritative, including an incomplete/empty one. Its
      // UI entries destroy positional alignment; never zip its keys with the
      // legacy array or fill missing keys from that potentially divergent array.
      const widgetNames = new Set(widgetNamesFor(node.type, objectInfo, node))
      const linkedNames = new Set((node.inputs ?? []).filter((entry) => entry.link != null)
        .flatMap((entry) => [entry.name, entry.widget?.name].filter((name): name is string => typeof name === 'string')))
      for (const [name, value] of Object.entries(node.widgets_values_named)) {
        if (!safeInputName(name) || uiOnlyWidgetName(name) || linkedNames.has(name) || Object.hasOwn(inputs, name)) continue
        const declared = inputSpec(objectInfo, node.type, name) !== undefined
        const dynamicLora = node.type === 'Power Lora Loader (rgthree)' && /^lora_\d+$/.test(name)
        if (dynamicLora && (!isObject(value)
          || !['on', 'lora', 'strength'].every((key) => Object.hasOwn(value, key))
          || typeof value.on !== 'boolean' || typeof value.lora !== 'string'
          || typeof value.strength !== 'number' || !Number.isFinite(value.strength)
          || (Object.hasOwn(value, 'strengthTwo') && value.strengthTwo !== null
            && (typeof value.strengthTwo !== 'number' || !Number.isFinite(value.strengthTwo))))) {
          return { ok: false, error: `Узел ${node.type} (id ${node.id}), вход ${name}: некорректное значение LoRA` }
        }
        if (value !== undefined && (declared || widgetNames.has(name) || dynamicLora)) inputs[name] = value
      }
    } else if (Array.isArray(values)) {
      let valueIndex = 0
      for (const name of widgetNamesFor(node.type, objectInfo, node)) {
        if (valueIndex >= values.length) break
        // control_after_generate is a frontend-only seed dropdown whose value
        // still occupies a widgets_values slot; it has no API input, so
        // consume (advance the index) but never emit it into the workflow.
        if (!safeInputName(name) || name === 'control_after_generate') {
          valueIndex++
          continue
        }
        if (!(name in inputs)) inputs[name] = values[valueIndex]
        valueIndex++
      }
    } else if (isObject(values)) {
      // Some nodes (e.g. VHS_VideoCombine) serialize widgets as a keyed object
      // including internal UI state; copy the plain input values by name.
      for (const [name, value] of Object.entries(values)) {
        if (!safeInputName(name)) continue
        if (name === 'videopreview') continue
        if (isObject(value) && value.hidden === true) continue
        if (!(name in inputs)) inputs[name] = value
      }
    }

    // DynamicCombo V3 stays FLAT in the API prompt: the master input holds the
    // selected option key as a string and its sub-widgets sit beside it as
    // `master.sub` keys. The server rebuilds the nested shape itself
    // (DynamicCombo._expand_schema_for_dynamic matches the plain value against
    // option keys); wrapping it as { key, inputs } never matches, the input is
    // dropped, and the node dies at execute() — Issue #10 (SaveVideo 'codec').
    // Validate the selected key here so a bad value fails at extraction rather
    // than after a full generation.
    for (const [name, value] of Object.entries(inputs)) {
      const spec = inputSpec(objectInfo, node.type, name)
      if (!Array.isArray(spec) || spec[0] !== 'COMFY_DYNAMICCOMBO_V3') continue
      const keys = dynamicComboKeys(spec)
      if (keys === undefined || Array.isArray(value)) continue
      if (typeof value !== 'string' || !keys.includes(value)) {
        return {
          ok: false,
          error: `Узел ${node.type} (id ${node.id}), вход ${name}: значение ${JSON.stringify(value)} не входит в список вариантов (${keys.join(' / ')}); выберите значение на холсте ComfyUI перед извлечением`,
        }
      }
    }

    workflow[String(node.id)] = { class_type: node.type, inputs }
  }

  if (Object.keys(workflow).length === 0) {
    return { ok: false, error: 'Результат преобразования пуст (нет выполняемых узлов)' }
  }

  // Reference integrity: every link must point at a node of this same output.
  // A component that leaves out an upstream node would otherwise extract as
  // ok and only fail at run time (Issue #8).
  for (const [id, node] of Object.entries(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') continue
      if (workflow[value[0]] === undefined) {
        return {
          ok: false,
          error: `Узел ${node.class_type} (id ${id}), вход ${name} ссылается на узел вне извлекаемой области: ${value[0]}; извлеките всё в один процесс или выделите эту область в независимый процесс`,
        }
      }
    }
  }

  // Fail loudly on nodes whose required inputs are missing — the source graph
  // itself is broken (inputs never wired), and the server would only echo a
  // confusing per-node error at run time. Growable/lazy v3 inputs (template
  // types like COMFY_AUTOGROW_V3) are skipped: their generated sub-inputs
  // (values.a, sampling_mode.temperature, ...) satisfy them.
  for (const [id, node] of Object.entries(workflow)) {
    const def = objectInfo[node.class_type]
    const required = isObject(def) && isObject(def.input) && isObject(def.input.required)
      ? Object.keys(def.input.required)
      : []
    const missing = required.filter((name) => {
      if (name in node.inputs) return false
      const spec = inputSpec(objectInfo, node.class_type, name)
      const options = Array.isArray(spec) && isObject(spec[1]) ? spec[1] : undefined
      return options?.lazy !== true && options?.template === undefined
    })
    if (missing.length > 0) {
      const parts = missing.map((name) => {
        const hints = brokenInputs.get(`${id}.${name}`)
        return hints !== undefined && hints.length > 0
          ? `${name} (связь из исходного графа удалена при преобразовании: ${hints[0]})`
          : name
      })
      const hadBroken = missing.some((name) => (brokenInputs.get(`${id}.${name}`)?.length ?? 0) > 0)
      return {
        ok: false,
        error: `Узел ${node.class_type} (id ${id}): отсутствуют обязательные входы: ${parts.join(', ')}`
          + (hadBroken
            ? '; удалённые связи нельзя представить в API: подключите вход к допустимому выходу (например, out0 переключателя) или удалите связь перед извлечением'
            : '; эти входы не подключены в исходном графе'),
      }
    }
  }

  return { ok: true, workflow, warnings }
}
