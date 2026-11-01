import { parseContextWindow } from '../shared/model-context.mjs'
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateModelConfig } from './model-reply.mjs'
import { TaskInputError } from './task-config.mjs'

const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const selectionId = entry => `registered:${entry.id}:${createHash('sha256').update(entry.model).digest('hex').slice(0, 12)}`
const publicEntry = entry => ({ id: entry.id, selectionId: selectionId(entry), providerId: entry.providerId,
  baseUrl: entry.baseUrl, model: entry.model, contextWindow: parseContextWindow(entry.contextWindow), hasKey: Boolean(entry.apiKey), source: 'file' })
const validId = id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)

// Credentials live only in a private local file, outside Harness/SQLite and receipts.
export function createModelRegistry({ file }) {
  const path = join(dirname(file), 'model-registrations.json')
  let queue = Promise.resolve()
  const requests = new Map()
  async function read() {
    try {
      const entries = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(entries) || entries.length > 100 || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error()
      return entries.map(entry => {
        if (!validId(entry.id) || typeof entry.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(entry.providerId) || entry.providerId.includes(entry.apiKey)) throw new Error()
        return { id: entry.id, providerId: entry.providerId, ...validateModelConfig(entry), contextWindow: parseContextWindow(entry.contextWindow) }
      })
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw new Error('PIDOT_模型注册表无效或不可读取。')
    }
  }
  return {
    read,
    list: async () => (await read()).map(publicEntry),
    config: async selected => {
      const entries = await read()
      const entry = selected ? entries.find(item => selectionId(item) === selected.id) : entries[0]
      return entry ? { ...validateModelConfig(entry), selectionId: selectionId(entry), providerId: entry.providerId } : undefined
    },
    save(input) {
      const operation = queue.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['id', 'requestId', 'providerId', 'baseUrl', 'model', 'apiKey', 'contextWindow'].includes(key)) ||
          typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) || ['constructor', 'prototype'].includes(input.requestId) ||
          input.id !== undefined && !validId(input.id) ||
          typeof input.providerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(input.providerId) ||
          input.apiKey !== undefined && typeof input.apiKey !== 'string') fail(400, 'INVALID_MODEL_SETTINGS', '供应商 ID 或模型配置字段无效。')
        const signature = createHash('sha256').update(JSON.stringify([input.id, input.providerId, input.baseUrl, input.model, input.apiKey ?? '', input.contextWindow])).digest('hex')
        const prior = requests.get(input.requestId)
        if (prior) {
          if (prior.signature !== signature) fail(409, 'MODEL_SETTINGS_REQUEST_CONFLICT', '同一 requestId 不能用于不同模型设置。')
          return { ...prior.result }
        }
        const entries = await read(), previous = entries.find(entry => entry.id === input.id)
        if (input.id && !previous) fail(404, 'MODEL_REGISTRATION_NOT_FOUND', '此模型配置不存在，请重新读取。')
        let config
        try {
          config = validateModelConfig({ baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey?.trim() ? input.apiKey : previous?.apiKey, contextWindow: parseContextWindow(input.contextWindow) })
          if (input.providerId.includes(config.apiKey)) throw new Error()
        } catch { fail(400, 'INVALID_MODEL_SETTINGS', '请检查供应商 ID、地址、模型名、上下文容量和 API key；新配置必须填写 key。') }
        if (entries.some(entry => entry.id !== input.id && entry.providerId === input.providerId && entry.model === config.model)) fail(409, 'MODEL_REGISTRATION_EXISTS', '这个供应商下已登记同名模型，请编辑已有配置。')
        if (!previous && entries.length >= 100) fail(400, 'INVALID_MODEL_SETTINGS', '最多登记 100 条模型配置。')
        const entry = { id: previous?.id ?? randomUUID(), providerId: input.providerId, ...config }
        if (previous) entries[entries.indexOf(previous)] = entry
        else entries.push(entry)
        const temporary = join(dirname(path), `.model-registrations-${randomUUID()}.tmp`)
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const handle = await open(temporary, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(entries)); await handle.sync() } finally { await handle.close() }
          await rename(temporary, path)
        } catch { fail(500, 'MODEL_SETTINGS_WRITE_FAILED', '模型配置保存失败，请检查本机存储权限。') }
        finally { await rm(temporary, { force: true }).catch(() => {}) }
        const result = publicEntry(entry)
        requests.set(input.requestId, { signature, result })
        return { ...result }
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
}
