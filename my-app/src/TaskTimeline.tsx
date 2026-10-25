import { buildTimeline, STATUS_LABELS } from './timeline.mjs'
import { dayKey, hm } from './calendar-layout.mjs'

// PLAN §8.4 Task timeline (P-14): model turns, tool calls, results, approvals, questions and the
// end, in time order. Each row shows a one-line summary; the raw arguments/result open on demand.
const icons: Record<string, string> = { input: '✎', model: '◆', tool: '⚙', reply: '✓', error: '!', approval: '?', decision: '☑', receipt: '◎', question: '?', answer: '✓', system: '•', end: '■' }

function when(at: string | null) {
  if (!at) return ''
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return ''
  return dayKey(ms) === dayKey(Date.now()) ? hm(ms) : `${dayKey(ms).slice(5)} ${hm(ms)}`
}

export default function TaskTimeline({ task }: { task: unknown }) {
  const entries = buildTimeline(task)
  if (!entries.length) return <p className="shell-muted timeline-empty">还没有执行记录。</p>
  return <ol className="timeline" aria-label="Task 时间线">
    {entries.map(e => <li key={e.id} className={`timeline-item timeline-${e.kind} timeline-status-${e.status}`}>
      <span className="timeline-icon" aria-hidden="true">{icons[e.kind]}</span>
      <div className="timeline-body">
        <div className="timeline-head">
          <strong>{e.title}</strong>
          {STATUS_LABELS[e.status] && <span className="timeline-status">{STATUS_LABELS[e.status]}</span>}
          {e.at && <time dateTime={e.at}>{when(e.at)}</time>}
        </div>
        {(e.summary || e.result) && <p className="timeline-summary">{[e.summary, e.result].filter(Boolean).join(' → ')}</p>}
        {e.detail !== undefined && <details className="timeline-detail"><summary>{e.kind === 'tool' ? `原文${e.tool ? ` · ${e.tool}` : ''}` : '原文'}</summary><pre>{typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2)}</pre></details>}
      </div>
    </li>)}
  </ol>
}
