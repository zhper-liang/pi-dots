import { parseContextWindow } from '../shared/model-context.mjs'
import { WORKSPACE_TOOLS } from './workspace-tools.mjs'
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { stream } from '@earendil-works/pi-ai/api/openai-completions'
import { DEFAULT_CALL_LIMITS } from './tools.mjs'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { safeRetryMetadata } from './continuous-retry.mjs'

// OpenAI-compatible function names exclude dots; MCP names remain canonical.
const toModelTool = name => WORKSPACE_TOOLS.includes(name) ? name.replace('.', '_') : name
const fromModelTool = name => WORKSPACE_TOOLS.find(n => toModelTool(n) === name) ?? name

export const MODEL_ERRORS = Object.freeze({
  CONTEXT_CAPACITY_EXCEEDED: '当前任务的固定规则或最小完整工具回合超出已配置模型容量，无法安全压缩；进度和历史已保留，请调整新Task的已核实模型容量。',
  CONTEXT_SUMMARY_INVALID: '历史摘要无效或过大，已保留原始进度和历史，未重做业务操作。',
  MODEL_AUTH_FAILED: '模型服务鉴权失败，请检查服务端凭证。',
  MODEL_TIMEOUT: '模型请求超时，请稍后发送新消息重试。',
  MODEL_RATE_LIMITED: '模型服务限流，请稍后重试。',
  MODEL_UNAVAILABLE: '模型服务暂不可用，请稍后重试。',
  MODEL_REJECTED: '模型服务拒绝了请求。可能是模型名称、接口兼容性或参数不受支持，请检查模型配置；不会自动换模型。',
  MODEL_OUTPUT_LIMIT: '模型达到单次输出 Token 上限，本次生成未完成；已保存可获得的实际用量，不会自动重试。',
  MODEL_INVALID_REPLY: '模型未返回完整文本回复，本次执行失败。',
  MODEL_CONFIG_UNAVAILABLE: '此 Task 的固定模型配置当前不可用；不会切换模型或返回测试回复。',
  MODEL_ABORTED: '此 Task 已取消，已尝试中止在途模型请求；未返回完整回复，用量按实际回执保留。',
  MODEL_FAILED: '模型请求失败，请检查服务端连接配置。',
})
export class ModelReplyError extends Error {
  constructor(code) { super(MODEL_ERRORS[code] ?? MODEL_ERRORS.MODEL_FAILED); this.code = Object.hasOwn(MODEL_ERRORS, code) ? code : 'MODEL_FAILED' }
}

/** Validate server-owned connection data without including values in errors. */
export function validateModelConfig({ baseUrl, apiKey, model, contextWindow } = {}) {
  let url
  try { url = new URL(baseUrl) } catch { throw new Error('PIDOT_模型接口地址无效。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey) || apiKey.length > 8192 ||
    typeof model !== 'string' || !/^[\w./:-]{1,200}$/.test(model) ||
    url.href.includes(apiKey) || model.includes(apiKey)) {
    throw new Error('PIDOT_真实模型需配置安全的 base_url、MODEL 和服务端 OPENAI_API_KEY。')
  }
  return { baseUrl: url.href.replace(/\/$/, ''), apiKey, model, ...(contextWindow === undefined ? {} : { contextWindow: parseContextWindow(contextWindow) }) }
}

/** Process > app dotenv > root dotenv; partial/invalid configuration fails closed. */
export async function readModelEnvironment({ env = process.env, file, files = file === undefined
  ? [new URL('../.env', import.meta.url), new URL('../../.env', import.meta.url)] : [file] } = {}) {
  if (env.PIDOT_REPLY_MODE === 'test') return { mode: 'test' }
  const sources = [env]
  for (const path of files) {
    try { sources.push(parseEnv(await readFile(path, 'utf8'))) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const get = (...names) => sources.flatMap(source => names.map(name => source[name])).find(value => value !== undefined)
  const mode = get('PIDOT_REPLY_MODE')
  if (mode === 'test') return { mode }
  if (mode !== undefined && mode !== 'model') throw new Error('PIDOT_REPLY_MODE 仅支持 model 或 test。')
  const baseUrl = get('OPENAI_BASE_URL', 'base_url'), apiKey = get('OPENAI_API_KEY'), model = get('MODEL')
  if ([baseUrl, apiKey, model].every(value => value === undefined) && mode !== 'model') return { mode }
  let contextWindow
  const rawWindows = get('PIDOT_CONTEXT_WINDOWS')
  if (rawWindows !== undefined) {
    try {
      const windows = JSON.parse(rawWindows)
      if (!windows || typeof windows !== 'object' || Array.isArray(windows)) throw new Error()
      if (Object.hasOwn(windows, model)) contextWindow = parseContextWindow(windows[model])
    } catch { throw new Error('PIDOT_CONTEXT_WINDOWS 模型容量配置无效。') }
  }
  return { mode: 'model', config: validateModelConfig({ baseUrl, apiKey, model, contextWindow }) }
}

export async function readModelConfig(options) { return (await readModelEnvironment(options)).config }

export function modelParameters(config) {
  return { mode: 'model', contextWindows: { [config.selectionId ?? config.model]: parseContextWindow(config.contextWindow) }, model: { provider: 'openai-compatible', api: 'openai-completions', id: config.selectionId ?? config.model, baseUrl: config.baseUrl },
    thinkingLevel: 'off', maxOutputTokens: 4096, requestTimeoutMs: 60000, tools: [], callLimits: { ...DEFAULT_CALL_LIMITS } }
}

/** The snapshot pins the model selection; resolve the live connection for every invocation. */
export function createModelReply(readConfig, { fetch: fetchImpl = globalThis.fetch } = {}) {
  const knownKeys = new Set()
  const redactText = value => [...knownKeys].reduce((text, key) => text.split(key).join('[已隐藏凭证]'), value)
  return async (message, { parameters, signal, context } = {}) => {
    let config
    try { config = typeof readConfig === 'function' ? await readConfig(parameters?.model) : readConfig } catch { throw new ModelReplyError('MODEL_CONFIG_UNAVAILABLE') }
    if (config?.apiKey) knownKeys.add(config.apiKey)
    const selected = parameters?.model
    const model = selected && { id: config?.selectionId ? config.model : selected.id, provider: 'openai-compatible', api: 'openai-completions', baseUrl: config?.baseUrl }
    if (!config || parameters?.mode !== 'model' || !['off', 'low', 'high'].includes(parameters.thinkingLevel) ||
      typeof model?.id !== 'string' || !/^[\w./:-]{1,200}$/.test(model.id) ||
      !Number.isInteger(parameters.requestTimeoutMs) || parameters.requestTimeoutMs < 1 || parameters.requestTimeoutMs > 600000) {
      throw new ModelReplyError('MODEL_CONFIG_UNAVAILABLE')
    }
    const maxOutputTokens = parameters.maxOutputTokens ?? 4096
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32768) throw new ModelReplyError('MODEL_CONFIG_UNAVAILABLE')
    let status, retryAfter, responseAt, networkCode, sent, responseModel, receivedExecution, usageKnown = false
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let timer
    let timedOut = false
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ModelReplyError('MODEL_TIMEOUT')) }, parameters.requestTimeoutMs)
    })
    try {
      // Token prices remain unknown; context capacity is local bookkeeping, not a provider override.
      // Pi requires catalog bookkeeping fields; NaN rates denote unknown cost, never persisted.
      // low/high map to the provider's standard reasoning_effort field only when the Task asked for it.
      const reasoning = parameters.thinkingLevel === 'low' || parameters.thinkingLevel === 'high'
      const descriptor = { ...model, name: model.id, reasoning, input: ['text'],
        cost: { input: NaN, output: NaN, cacheRead: NaN, cacheWrite: NaN },
        contextWindow: parameters.contextWindows?.[selected.id] ?? parseContextWindow(config.contextWindow), maxTokens: 0,
        compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: reasoning, supportsUsageInStreaming: true } }
      const response = await Promise.race([stream(descriptor, normalizeContext(context ?? { messages: [
        { role: 'user', content: message, timestamp: Date.now() },
      ] }), {
        apiKey: config.apiKey, signal: controller.signal, timeoutMs: parameters.requestTimeoutMs, maxTokens: maxOutputTokens, maxRetries: 0,
        ...(reasoning ? { reasoningEffort: parameters.thinkingLevel } : {}),
        fetch: async (url, init) => {
          try {
            const result = await fetchImpl(url, { ...init, redirect: 'error' })
            status = result.status
            retryAfter = result.headers.get('retry-after')
            responseAt = Date.now()
            return result
          } catch (error) {
            networkCode = error?.code ?? error?.cause?.code
            throw error
          }
        },
        onPayload: (payload) => {
          // DeepSeek's thinking extension is not part of Chat Completions.
          // Strict GPT gateways reject it even when explicitly disabled.
          if (/(?:^|\/)deepseek[-/]/i.test(model.id)) payload.thinking = reasoning ? { type: 'enabled' } : { type: 'disabled' }
          for (const tool of payload.tools ?? []) if (tool.function) tool.function.name = toModelTool(tool.function.name)
          for (const message of payload.messages ?? []) {
            for (const call of message.tool_calls ?? []) if (call.function) call.function.name = toModelTool(call.function.name)
            if (message.role === 'tool' && message.name) message.name = toModelTool(message.name)
          }
          // bb-api compatibility: keep the exact text, change only system content encoding.
          for (const item of payload.messages ?? []) {
            if (item.role === 'system' && typeof item.content === 'string') {
              item.content = [{ type: 'text', text: item.content }]
            }
          }
          // Keep only the allowlisted actual request fields, never headers or messages.
          sent = { provider: model.provider, api: model.api, baseUrl: model.baseUrl, model: payload.model,
            thinkingLevel: parameters.thinkingLevel, ...(payload.thinking ? { thinking: { ...payload.thinking } } : {}),
            ...(reasoning ? { reasoningEffort: payload.reasoning_effort } : {}), stream: payload.stream,
            timeoutMs: parameters.requestTimeoutMs, maxOutputTokens, maxRetries: 0 }
        },
        onProviderStreamEvent: (event) => {
          if (Number.isSafeInteger(event.usage?.total_tokens) && event.usage.total_tokens >= 0) usageKnown = true
          if (typeof event.model === 'string' && /^[\w./:-]{1,200}$/.test(event.model) && redactText(event.model) === event.model) responseModel = event.model
        },
      }).result(), deadline])
      if (timedOut) throw new ModelReplyError('MODEL_TIMEOUT')
      const usage = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
        .filter((key) => usageKnown && Number.isFinite(response.usage?.[key]) && response.usage[key] >= 0).map((key) => [key, response.usage[key]]))
      if (sent) receivedExecution = { ...sent, ...(responseModel ? { responseModel } : {}), finishReason: response.stopReason, usage }
      if (response.stopReason === 'length') throw new ModelReplyError('MODEL_OUTPUT_LIMIT')
      if (response.stopReason === 'error' || response.stopReason === 'aborted') {
        throw new ModelReplyError(response.stopReason === 'aborted' && signal?.aborted ? 'MODEL_ABORTED' : status === 401 || status === 403 ? 'MODEL_AUTH_FAILED'
          : status === 429 ? 'MODEL_RATE_LIMITED' : status === 408 || status === 504 ? 'MODEL_TIMEOUT'
          : status >= 500 ? 'MODEL_UNAVAILABLE' : status >= 400 ? 'MODEL_REJECTED' : 'MODEL_FAILED')
      }
      const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const calls = response.content.filter((block) => block.type === 'toolCall')
      const toolTurn = response.stopReason === 'toolUse' && calls.length > 0 && calls.length <= 16 &&
        new Set(calls.map((call) => call.id)).size === calls.length && calls.every((call) =>
          typeof call.id === 'string' && call.id.length > 0 && call.id.length <= 200 &&
          typeof call.name === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(call.name))
      if ((!toolTurn && (response.stopReason !== 'stop' || calls.length || !text.trim())) || !sent) {
        throw new ModelReplyError('MODEL_INVALID_REPLY')
      }
      const redact = (value) => typeof value === 'string' ? redactText(value)
        : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), redact(item)])) : value
      const content = response.content.filter((block) => ['text', 'toolCall'].includes(block.type)).map((block) =>
        block.type === 'text' ? { type: 'text', text: redact(block.text) } : { type: 'toolCall', id: redact(block.id),
          name: fromModelTool(redact(block.name)), arguments: redact(block.arguments), ...(block.argumentsError ? { argumentsError: 'INVALID_JSON_OBJECT' } : {}) })
      return { mode: 'model', ...(toolTurn ? { toolCalls: content.filter((block) => block.type === 'toolCall'),
        assistant: { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          stopReason: 'toolUse', usage, timestamp: Date.now() } } : {}), reply: { role: 'assistant', content: redactText(text) },
        execution: { ...sent, ...(responseModel ? { responseModel } : {}), finishReason: response.stopReason, usage } }
    } catch (error) {
      const failure = timedOut ? new ModelReplyError('MODEL_TIMEOUT') : error instanceof ModelReplyError ? error : new ModelReplyError(signal?.aborted ? 'MODEL_ABORTED' : 'MODEL_FAILED')
      if (receivedExecution) failure.execution = receivedExecution
      // Keep retry classification separate from user text and credential-bearing transport errors.
      failure.retryMetadata = safeRetryMetadata({ status, retryAfter, networkCode, now: responseAt ?? Date.now() })
      throw failure
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
}
