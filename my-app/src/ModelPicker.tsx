import { formatContextWindow } from '../shared/model-context.mjs'
import { useEffect, useState } from 'react'
import { modelChoices, type ModelChoice } from './model-settings-ui.mjs'
import './model-settings.css'

export type ComposerModel = { id: string }
export type ModelPickerTask = { taskId: number; kind?: string; bot: { id: string }; group?: unknown; parameters: { mode?: unknown; model?: unknown } }
export type ModelPickerProps = {
  token: string
  task: ModelPickerTask
  value?: ComposerModel
  disabled?: boolean
  onChange: (model: ComposerModel) => void
}

// Controlled per-input choice. The root owns per-task drafts and sends { model: { id } }.
// Mount with key={task.taskId}; no settings, credentials or historical messages are mutated here.
export default function ModelPicker({ token, task, value, disabled = false, onChange }: ModelPickerProps) {
  const [models, setModels] = useState<ModelChoice[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const editable = task.kind === 'main' && !task.group && task.parameters.mode === 'model'
  const snapshot = task.parameters.model as ComposerModel | null | undefined
  const current = editable ? value?.id ?? snapshot?.id ?? '' : snapshot?.id ?? ''
  const botId = task.bot.id
  useEffect(() => {
    if (!editable) return
    let live = true
    const controller = new AbortController()
    let revision = 0
    const refresh = () => {
      const request = ++revision
      setLoading(true)
      fetch(`/api/bots/${encodeURIComponent(botId)}/configuration`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error('unavailable')
          const result = await response.json()
          if (!Array.isArray(result.models)) throw new Error('unavailable')
          if (live && request === revision) { setModels(result.models); setError(''); setLoading(false) }
        }).catch(() => { if (live && request === revision && !controller.signal.aborted) { setModels([]); setLoading(false); setError('模型列表读取失败，保留当前模型。') } })
    }
    refresh()
    window.addEventListener('pidot:model-settings-updated', refresh)
    return () => { live = false; controller.abort(); window.removeEventListener('pidot:model-settings-updated', refresh) }
  }, [token, botId, editable])
  if (!editable) return <span className="pd-tool pd-tool-static" title="本会话使用的模型">{task.parameters.mode === 'model' ? current || '模型' : '测试模式'}</span>
  const choices = modelChoices(current, models)
  const available = new Set(modelChoices('', models))
  const labels = new Map(models.filter(model => model && typeof model.id === 'string').map(model => [model.id, `${model.name ?? model.id}${model.name && model.provider ? ` · ${model.provider}` : ''} · ${formatContextWindow(model.contextWindow)}`]))
  return <>
    <label className="pd-tool model-picker" title="从下一条消息开始用这个模型"><span>模型</span><select aria-label="下一条消息的模型" value={current} disabled={disabled || loading || available.size === 0} onChange={event => { if (available.has(event.target.value)) onChange({ id: event.target.value }) }}>{!current && <option value="" disabled>{loading ? '读取中…' : '请选择模型'}</option>}{choices.map(id => <option key={id} value={id} disabled={!available.has(id)}>{labels.get(id) ?? id}{!loading && !error && !available.has(id) ? '（当前，不在可选列表）' : ''}</option>)}</select></label>
    {error && <span className="model-picker-error" role="status">{error}</span>}
  </>
}
