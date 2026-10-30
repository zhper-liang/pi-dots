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
  return [...new Set([current, ...(Array.isArray(models) ? models.filter(object).map(item => item.id) : [])].filter(id => typeof id === 'string' && /^[\w./:-]{1,200}$/.test(id)))]
}

// A summary is a configuration receipt, not an unperformed connectivity check.
// Show only the origin: paths, userinfo, query and fragment can contain credentials.
export function modelSettingsSummary(settings) {
  let address = '未配置'
  if (settings.baseUrl) {
    try {
      const url = new URL(settings.baseUrl)
      address = ['https:', 'http:'].includes(url.protocol) ? url.origin : '地址无效'
    } catch { address = '地址无效' }
  }
  const configured = Boolean(settings.baseUrl && settings.model && settings.hasKey)
  return {
    model: settings.model || '未设置模型',
    address,
    key: settings.hasKey ? '已配置' : '未配置',
    status: configured ? '已配置 · 未验证连接' : '待配置',
    readOnly: settings.source === 'env',
  }
}

// A failed/unknown save must replay the same body and id, not invent a new mutation.
export function modelSettingsAttempt(input, previous, requestId) {
  const candidate = modelSettingsPayload(input, previous?.requestId ?? '')
  if (previous && JSON.stringify(candidate) === JSON.stringify(previous)) return previous
  return { ...candidate, requestId: requestId() }
}
