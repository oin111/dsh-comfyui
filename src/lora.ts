/** Narrow rgthree row contract shared by host and browser. */
export interface LoraValue extends Record<string, unknown> {
  on: boolean
  lora: string
  strength: number
  strengthTwo?: number | null
}

export function isLoraInput(classType: string, inputKey: string): boolean {
  return classType === 'Power Lora Loader (rgthree)' && /^lora_\d+$/.test(inputKey)
}

export function isLoraValue(value: unknown): value is LoraValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return typeof row.on === 'boolean' && typeof row.lora === 'string' &&
    typeof row.strength === 'number' && Number.isFinite(row.strength) &&
    (row.strengthTwo === undefined || row.strengthTwo === null ||
      (typeof row.strengthTwo === 'number' && Number.isFinite(row.strengthTwo)))
}
