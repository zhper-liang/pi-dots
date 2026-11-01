import { useEffect, useId, useRef, useState } from 'react'
import type { MemoryDocument, MemoryEdit, MemoryFileStatus, MemoryItem, MemoryKind, MemoryOutcome, MemoryRevision, MemorySource, MemorySourceHandler } from './memory-types'
import { createMemoryRequestTracker, memoryActorLabel, memoryDate, memoryErrorMessage, memoryFileView, memoryHandwritten, memorySavedNotice, reconcileMemoryDraft } from './memory-helpers.mjs'
import './memory.css'

const Handwritten = ({ item }: { item: Pick<MemoryItem, 'sourceEntries'> }) => memoryHandwritten(item) ? <span className="memory-tag">手写</span> : null

/** R2 file mode only: where the file lives, when it last matched, and why it is not used. Nothing when file is null. */
function MemoryFileState({ file, kind }: { file?: MemoryFileStatus | null; kind: MemoryKind }) {
  const view = memoryFileView(file, kind)
  if (!view) return null
  return <div className="memory-file-state">
    <dl className="memory-file"><dt>文件位置</dt><dd><code>{view.path}</code></dd><dt>最近同步</dt><dd>{view.synced}</dd></dl>
    {view.reason && <p className="memory-pending" role="status">{view.reason}</p>}
  </div>
}

export function MemorySources({ sources, onOpenSource }: { sources: MemorySource[]; onOpenSource?: MemorySourceHandler }) {
  if (!sources.length) return null
  return <details><summary>原对话（{sources.length}）</summary><ul className="memory-sources">{sources.map((source, index) => <li key={`${source.taskId}:${source.entryId}`}>
    {onOpenSource ? <button type="button" onClick={() => onOpenSource(source)}>查看原对话 {index + 1}</button> : <span>原对话 {index + 1}</span>}
    <span className="memory-meta"> · 任务 {source.taskId} · 消息 {source.entryId}</span>
  </li>)}</ul></details>
}

function MemoryHistory({ history, truncated, onOpenSource }: { history?: MemoryRevision[]; truncated?: boolean; onOpenSource?: MemorySourceHandler }) {
  return <details className="tech-info"><summary>最近历史{history ? `（${history.length}）` : ''}</summary>
    {!history ? <p className="memory-hint">暂未读取到历史，请刷新后查看。</p> : !history.length ? <p className="memory-hint">还没有编辑记录。</p> : <ol className="memory-history">{history.map(revision => <li key={revision.version}>
      <p className="memory-meta">版本 {revision.version} · {memoryDate(revision.updatedAt)} · {memoryActorLabel(revision.actor)}</p>
      {revision.kind === 'personality' ? <p className="memory-content">{revision.content || '人格已清空'}</p> : (revision.items?.length ? revision.items.map(item => <p key={item.id} className="memory-content">{item.content}<Handwritten item={item} /></p>) : <p className="memory-hint">没有条目</p>)}
      <MemorySources sources={revision.sourceEntries} onOpenSource={onOpenSource} />
    </li>)}</ol>}
    {truncated && <p className="memory-hint">仅显示最近 20 个版本，更早的记录仍保留。</p>}
  </details>
}

type Draft = { action: 'set' | 'update' | 'delete'; id?: string; content: string; expectedVersion: number; sourceEntries: MemorySource[] }
type SectionProps = {
  title: string; description: string; document: MemoryDocument; history?: MemoryRevision[]; truncated?: boolean; readOnly?: boolean
  onEdit?: (edit: MemoryEdit) => Promise<MemoryOutcome>; onRefresh: () => Promise<void>; onOpenSource?: MemorySourceHandler
}

export function MemoryDocumentSection({ title, description, document: doc, history, truncated, readOnly = false, onEdit, onRefresh, onOpenSource }: SectionProps) {
  const id = useId()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const tracker = useRef(createMemoryRequestTracker())
  const mounted = useRef(true)
  const flight = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = draft?.id ? doc.items?.find(item => item.id === draft.id) : undefined
  const mismatch = reconcileMemoryDraft(draft, doc).conflicted
  const editable = !readOnly && !!onEdit
  const blocked = busy || uncertain
  const limit = doc.kind === 'personality' ? 8192 : 2048
  function begin(item?: MemoryItem, deleting = false) {
    setDraft({ action: item ? deleting ? 'delete' : 'update' : 'set', id: item?.id, content: item?.content ?? doc.content ?? '', expectedVersion: doc.version, sourceEntries: item?.sourceEntries ?? doc.sourceEntries })
    setConflict(false); setError(''); setNotice('')
  }
  function discard() { setDraft(null); setConflict(false); setError(''); tracker.current.settle() }
  async function save() {
    if (!draft || !onEdit || readOnly || flight.current || (!uncertain && (mismatch || conflict))) return
    const request = tracker.current.prepare({ kind: doc.kind, action: draft.action, expectedVersion: draft.expectedVersion,
      ...(draft.id ? { id: draft.id } : {}), ...(draft.action === 'delete' ? {} : { content: draft.content, sourceEntries: draft.sourceEntries }) })
    flight.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const outcome = await onEdit(request)
      if (!mounted.current) return
      tracker.current.settle(); setUncertain(false)
      if (!outcome.ok) {
        setConflict(outcome.code === 'MEMORY_VERSION_CONFLICT' || outcome.code === 'MEMORY_ITEM_CONFLICT')
        setError(memoryErrorMessage(outcome.code))
      } else {
        setDraft(null); setConflict(false)
        setNotice(memorySavedNotice(draft.action, outcome.document?.file))
      }
    } catch (cause) {
      if (!mounted.current) return
      const failure = cause as { code?: string; ambiguous?: boolean; message?: string }
      const ambiguous = failure.ambiguous === true || !failure.code
      setUncertain(ambiguous)
      if (!ambiguous) tracker.current.settle()
      setConflict(failure.code === 'MEMORY_VERSION_CONFLICT' || failure.code === 'MEMORY_ITEM_CONFLICT')
      setError(ambiguous ? '没确认保存成功，草稿还在，点「重试」。' : memoryErrorMessage(failure.code))
    } finally {
      flight.current = false
      if (mounted.current) { setBusy(false); void onRefresh() }
    }
  }
  const itemEditor = draft && <div className="memory-editor">
    {draft.action === 'delete' ? <p>删除这条{title}？历史记录仍然保留。</p> : <>
      <label htmlFor={`${id}-draft`}>{doc.kind === 'personality' ? '编辑人格' : `纠正${title}`}</label>
      <textarea id={`${id}-draft`} rows={5} maxLength={limit} value={draft.content} disabled={blocked || !editable} aria-describedby={`${id}-draft-hint`} onChange={event => setDraft({ ...draft, content: event.target.value })} />
      <p id={`${id}-draft-hint`} className="memory-hint">{draft.content.length} / {limit} 字 · {doc.kind === 'personality' ? '由你编辑；不要填写密钥。留空可清除人格。' : draft.sourceEntries.length ? '纠正只改记忆，原对话不变。' : '手写条目，纠正后仍标为手写。'}</p>
    </>}
    {(mismatch || conflict) && <div className="memory-conflict" role="status">
      <p>内容已在别处改过，草稿还在，请对照后继续。</p>
      <p className="memory-content">当前内容：{draft.id ? current?.content ?? '这条内容已删除。' : doc.content || '未设置人格'}</p>
      {(!draft.id || current) && <button type="button" disabled={blocked || !editable} onClick={() => {
        tracker.current.settle(); setDraft({ ...draft, expectedVersion: doc.version, sourceEntries: current?.sourceEntries ?? doc.sourceEntries }); setConflict(false); setError('')
      }}>已对照，继续编辑</button>}
    </div>}
    <div className="memory-actions">
      <button type="button" className={draft.action === 'delete' ? 'memory-danger' : 'memory-primary'} disabled={busy || !editable || ((!uncertain) && (mismatch || conflict || (draft.action !== 'set' && draft.action !== 'delete' && !draft.content.trim())))} onClick={() => { void save() }}>{busy ? '正在保存…' : uncertain ? '重试' : draft.action === 'delete' ? '确认删除' : '保存'}</button>
      <button type="button" disabled={blocked} onClick={discard}>取消</button>
    </div>
  </div>
  return <section className="memory-section" aria-labelledby={`${id}-title`}>
    <div className="memory-section-head"><h2 id={`${id}-title`}>{title}</h2><span className="memory-meta">{memoryDate(doc.updatedAt)}</span></div>
    <p className="memory-hint">{description}</p>
    <p className="memory-meta">已用 {doc.kind === 'personality' ? (doc.content ?? '').length : (doc.items ?? []).reduce((sum, item) => sum + item.content.length, 0)} / {doc.kind === 'personality' ? 8192 : 16384} 字{doc.kind !== 'personality' && ` · ${doc.items?.length ?? 0} / 64 条`}</p>
    <MemoryFileState file={doc.file} kind={doc.kind} />
    {doc.status.state === 'pending' && <p className="memory-pending" role="status">{memoryErrorMessage(doc.status.code)}</p>}
    {doc.kind === 'personality' ? <>
      {draft ? itemEditor : <><p className={`memory-content${doc.content ? '' : ' memory-empty'}`}>{doc.content || '还没有设置人格。'}</p>{editable && <button type="button" onClick={() => begin()}>编辑人格</button>}</>}
      <MemorySources sources={doc.sourceEntries} onOpenSource={onOpenSource} />
    </> : <>
      {!doc.items?.length ? <p className="memory-empty">还没有{title}。在对话里说过的事，会在空闲时整理进来。</p> : <ul className="memory-items">{doc.items.map(item => <li key={item.id}>
        <p className="memory-content">{item.content}<Handwritten item={item} /></p>
        <MemorySources sources={item.sourceEntries} onOpenSource={onOpenSource} />
        {editable && !draft && <div className="memory-actions"><button type="button" onClick={() => begin(item)}>纠正</button><button type="button" className="memory-danger" onClick={() => begin(item, true)}>删除</button></div>}
        {draft?.id === item.id && itemEditor}
      </li>)}</ul>}
      {draft && !current && <div>{itemEditor}</div>}
    </>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {notice && <p className="memory-notice" role="status">{notice}</p>}
    {(history !== undefined || editable) && <MemoryHistory history={history} truncated={truncated} onOpenSource={onOpenSource} />}
  </section>
}
