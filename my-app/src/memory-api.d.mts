import type { MemoryApi } from './memory-types'
export function createMemoryApi(token: string, fetcher?: typeof fetch): MemoryApi
