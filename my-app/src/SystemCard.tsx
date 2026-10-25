import type { ReactNode } from 'react'
import { cardView, type CardInput } from './system-cards.mjs'

// PLAN §8.4 unified system card frame: kind badge, title, live state, body, buttons, error.
// Every conversation card (approval, question, mirror, finding, automatic execution, summary,
// routine proposal, Bot management) renders through this; button rules live in system-cards.mjs.
export default function SystemCard({ card, title, state, meta, actions, error, className = '', children }: {
  card: CardInput; title?: ReactNode; state?: string; meta?: ReactNode; actions?: ReactNode; error?: string; className?: string; children?: ReactNode
}) {
  const view = cardView(card)
  const shown = state ?? view.state
  return <article className={`system-card system-card-${view.kind} tone-${view.tone} ${className}`} data-card-kind={view.kind}>
    <header className="system-card-head">
      <span className="system-card-kind">{view.label}</span>
      {title && <strong className="system-card-title">{title}</strong>}
      {shown && <span className="system-card-state" role="status">{shown}</span>}
    </header>
    {meta && <p className="system-card-meta">{meta}</p>}
    {children}
    {actions && <div className="system-card-actions">{actions}</div>}
    {error && <p role="alert" className="system-card-error">{error}</p>}
  </article>
}
