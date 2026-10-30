export type LocalDateTime = { date: string; time: string; timezone: string }
export type LocalInstantInput = number | string | Date
export function getLocalTimezone(): string
export function isValidLocalDate(date: unknown): date is string
export function isValidLocalTime(time: unknown): time is string
export function localInstant(value: LocalDateTime): number | null
export function localDateTime(instant?: LocalInstantInput, timezone?: string): LocalDateTime | null
export function formatLocalDateTime(instant: LocalInstantInput, timezone?: string): string | null
export function validateLocalRange(start: LocalDateTime, end: LocalDateTime):
  | { start: number; end: number; error?: undefined }
  | { error: string; start?: undefined; end?: undefined }
