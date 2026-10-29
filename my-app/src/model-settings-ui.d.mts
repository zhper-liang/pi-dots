export type PublicModelSettings = { baseUrl: string; model: string; hasKey: boolean; source: 'env' | 'file' | 'none' }
export type ModelChoice = { id: string; provider?: string }
export function publicModelSettings(value: unknown): PublicModelSettings
export function modelSettingsPayload(input: { baseUrl: string; model: string; apiKey: string }, requestId: string): { requestId: string; baseUrl: string; model: string; apiKey?: string }
export const MODEL_SETTINGS_NOTICE: string
export function modelChoices(current: string, models?: ModelChoice[]): string[]
