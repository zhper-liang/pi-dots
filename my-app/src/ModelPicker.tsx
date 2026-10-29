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
  const [models, setModels] = useState<ModelChoice[]>([]), [error, setError] = useState('')
  const editable = task.kind === 'main' && !task.group && task.parameters.mode === 'model'
  const snapshot = task.parameters.model as ComposerModel | null | undefined
  const current = editable ? value?.id ?? snapshot?.id ?? '' : snapshot?.id ?? ''
  const botId = task.bot.id
  useEffect(() => {
    if (!editable) return
    let live = true
    const controller = new AbortController()
    const refresh = () => {
      fetch(`/api/bots/${encodeURIComponent(botId)}/configuration`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error('unavailable')
          const result = await response.json()
          if (!Array.isArray(result.models)) throw new Error('unavailable')
          if (live) { setModels(result.models); setError('') }
        }).catch(() => { if (live && !controller.signal.aborted) setError('模型列表读取失败，保留当前模型。') })
    }
    refresh()
    window.addEventListener('pidot:model-settings-updated', refresh)
    return () => { live = false; controller.abort(); window.removeEventListener('pidot:model-settings-updated', refresh) }
  }, [token, botId, editable])
  if (!editable) return <span className="pd-tool pd-tool-static" title="独立 Task 的模型快照只读；设置变化不会改写历史模型或用量">{task.parameters.mode === 'model' ? current || '模型' : '测试模式'}</span>
  return <>
    <label className="pd-tool model-picker" title="从下一条输入开始使用所选模型；当前调用、历史消息和用量不变"><span>模型</span><select aria-label="下一条输入的模型" value={current} disabled={disabled} onChange={event => onChange({ id: event.target.value })}>{modelChoices(current, models).map(id => <option key={id} value={id}>{id}</option>)}</select></label>
    {error && <span className="model-picker-error" role="status">{error}</span>}
  </>
}
