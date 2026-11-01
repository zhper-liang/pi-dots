export type PublicModelSettings = { baseUrl: string; model: string; hasKey: boolean; contextWindow: number; source: 'env' | 'file' | 'none' }
export type ModelChoice = { id: string; provider?: string; name?: string; contextWindow?: number }
export function publicModelSettings(value: unknown): PublicModelSettings
export function modelSettingsPayload(input: { baseUrl: string; model: string; apiKey: string; contextWindow?: string | number }, requestId: string): { requestId: string; baseUrl: string; model: string; apiKey?: string; contextWindow?: number }
export const MODEL_SETTINGS_NOTICE: string
export function modelChoices(current: string, models?: ModelChoice[]): string[]

export function modelSettingsSummary(settings: PublicModelSettings): { model: string; address: string; key: string; status: string; readOnly: boolean }
export function modelSettingsAttempt(input: { baseUrl: string; model: string; apiKey: string; contextWindow?: string | number }, previous: ReturnType<typeof modelSettingsPayload> | null, requestId: () => string): ReturnType<typeof modelSettingsPayload>

export type ModelRegistration = { id: string; selectionId: string; providerId: string; baseUrl: string; model: string; hasKey: boolean; contextWindow: number; source: 'env' | 'file' }
export function publicRegistrations(value: unknown): ModelRegistration[]
