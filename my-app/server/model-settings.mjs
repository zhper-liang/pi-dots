import { DEFAULT_CONTEXT_WINDOW, parseContextWindow } from '../shared/model-context.mjs'
import { readFile, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readModelEnvironment, validateModelConfig } from './model-reply.mjs'
import { createModelRegistry } from './model-registry.mjs'
import { TaskInputError } from './task-config.mjs'

const fail = (status, code, message) => { throw new TaskInputError(status, code, message) }
const project = (config, source) => ({ baseUrl: config?.baseUrl ?? '', model: config?.model ?? '', hasKey: Boolean(config?.apiKey), contextWindow: config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, source })

/** Credentials never enter Harness documents, SQLite, receipts, or API projections. */
export function createModelSettings({ file, env = process.env, envFiles }) {
  const path = join(dirname(file), 'model-settings.json')
  const registry = createModelRegistry({ file })
  let queue = Promise.resolve()
  const requests = new Map()
  async function resolve() {
    // Explicit test isolation must never accidentally enable a real provider.
    const { config, mode } = await readModelEnvironment({ env, ...(envFiles === undefined ? {} : { files: envFiles }) })
    if (mode === 'test') return { source: 'none', mode }
    if (config) return { config, source: 'env' }
    try { return { config: validateModelConfig(JSON.parse(await readFile(path, 'utf8'))), source: 'file' } }
    catch (error) { if (error.code === 'ENOENT') return { source: 'none' }; throw new Error('PIDOT_模型设置文件无效或不可读取。') }
  }
  return {
    read: async selected => {
      const current = await resolve()
      if (current.mode === 'test') return undefined
      if (selected?.id?.startsWith('registered:')) return registry.config(selected)
      return current.config ?? (selected ? undefined : registry.config())
    },
    list: async () => {
      const current = await resolve()
      if (current.mode === 'test') return []
      const entries = await registry.list()
      return [...(current.config ? [{ id: 'default', selectionId: current.config.model, providerId: 'openai-compatible', ...project(current.config, current.source) }] : []), ...entries]
    },
    secretKeys: async () => (await registry.read()).map(entry => entry.apiKey),
    saveRegistration: async input => {
      if ((await resolve()).mode === 'test') fail(409, 'MODEL_SETTINGS_TEST_MODE', '显式测试模式下不能启用真实模型。')
      return registry.save(input)
    },
    get: async () => { const { config, source } = await resolve(); return project(config, source) },
    save(input) {
      const operation = queue.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(key => !['requestId', 'baseUrl', 'model', 'apiKey', 'contextWindow'].includes(key)) ||
          typeof input.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(input.requestId) ||
          ['constructor', 'prototype'].includes(input.requestId) ||
          input.apiKey !== undefined && typeof input.apiKey !== 'string') {
          fail(400, 'INVALID_MODEL_SETTINGS', '模型设置字段或 requestId 无效。')
        }
        const current = await resolve()
        if (current.source === 'env') fail(409, 'MODEL_SETTINGS_ENV_LOCKED', '当前使用环境模型配置；请修改环境配置，界面保存不会覆盖它。')
        if (current.mode === 'test') fail(409, 'MODEL_SETTINGS_TEST_MODE', '显式测试模式下不能启用真实模型。')
        const signature = createHash('sha256').update(JSON.stringify([input.baseUrl, input.model, input.apiKey ?? '', input.contextWindow])).digest('hex')
        const prior = requests.get(input.requestId)
        if (prior) {
          if (prior.signature !== signature) fail(409, 'MODEL_SETTINGS_REQUEST_CONFLICT', '同一 requestId 不能用于不同模型设置。')
          return { ...prior.result }
        }
        let config
        try { config = validateModelConfig({ baseUrl: input.baseUrl, model: input.model, apiKey: input.apiKey?.trim() ? input.apiKey : current.config?.apiKey, contextWindow: parseContextWindow(input.contextWindow) }) }
        catch { fail(400, 'INVALID_MODEL_SETTINGS', '请提供安全模型地址、有效模型名和 API key；留空 key 只会保留已有凭证。') }
        const temporary = join(dirname(path), `.model-settings-${randomUUID()}.tmp`)
        try {
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          const handle = await open(temporary, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(config)); await handle.sync() } finally { await handle.close() }
          await rename(temporary, path)
        } catch { fail(500, 'MODEL_SETTINGS_WRITE_FAILED', '模型设置保存失败；请检查服务端存储权限。') }
        finally { await rm(temporary, { force: true }).catch(() => {}) }
        const result = project(config, 'file')
        requests.set(input.requestId, { signature, result })
        return { ...result }
      })
      queue = operation.catch(() => {})
      return operation
    },
  }
}
