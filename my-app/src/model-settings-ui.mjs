const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Project only the public contract: never retain an unexpected credential field.
export function publicModelSettings(value) {
  if (!object(value) || typeof value.baseUrl !== 'string' || typeof value.model !== 'string' ||
    typeof value.hasKey !== 'boolean' || !['env', 'file', 'none'].includes(value.source)) throw new Error('模型设置暂时不可用，请重试。')
  return { baseUrl: value.baseUrl, model: value.model, hasKey: value.hasKey, source: value.source }
}

export function modelSettingsPayload({ baseUrl, model, apiKey }, requestId) {
  return { requestId, baseUrl: baseUrl.trim(), model: model.trim(), ...(apiKey.trim() ? { apiKey } : {}) }
}

export const MODEL_SETTINGS_NOTICE = '对所有会话的下一次调用生效；独立 Task 保留模型名快照，主会话可为下一条输入选择模型。'

export function modelChoices(current, models = []) {
  return [...new Set([current, ...models.map(item => item.id)].filter(id => typeof id === 'string' && /^[\w./:-]{1,200}$/.test(id)))]
}
