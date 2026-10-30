export type PublicModelSettings = { baseUrl: string; model: string; hasKey: boolean; source: 'env' | 'file' | 'none' }
export type ModelChoice = { id: string; provider?: string }
export function publicModelSettings(value: unknown): PublicModelSettings
export function modelSettingsPayload(input: { baseUrl: string; model: string; apiKey: string }, requestId: string): { requestId: string; baseUrl: string; model: string; apiKey?: string }
export const MODEL_SETTINGS_NOTICE: string
export function modelChoices(current: string, models?: ModelChoice[]): string[]

export function modelSettingsSummary(settings: PublicModelSettings): { model: string; address: string; key: string; status: string; readOnly: boolean }
export function modelSettingsAttempt(input: { baseUrl: string; model: string; apiKey: string }, previous: ReturnType<typeof modelSettingsPayload> | null, requestId: () => string): ReturnType<typeof modelSettingsPayload>
