import { DEFAULT_COMPACTION_POLICY } from '@earendil-works/pi-durable'

// Pi 1.3.0 exports its task/policy publicly, but not its pure selection/serialization helpers.
// Resolve within the pinned installed package; do not reimplement those algorithms or add a second engine.
// Regression tests cover this adapter before any future Pi upgrade.
const { selectCut, serializeConversation } = await import(new URL('./harness/compaction.js', import.meta.resolve('@earendil-works/pi-durable')))
export { DEFAULT_COMPACTION_POLICY, serializeConversation }
export function piCompactionPrefix(segments, keepRecentTokens) {
  const view = { entries: segments.map(segment => ({ id: segment.entryId })), contributions: segments.map(segment => segment.messages) }
  const cut = selectCut(view, keepRecentTokens)
  return cut === undefined ? [] : segments.slice(0, cut)
}
// Structured checkpoint format from Pi's CompactionTask (MIT, earendil-works/pi).
// Pidot retains its durable Task and adds source/authorization instructions around this format.
export const PI_SUMMARY_PROMPT = `Create a structured context checkpoint that another LLM will use to continue the work.
If there is an earlier summary, preserve its information and fold the newer messages into it.
Use these sections, keep them concise, and preserve exact paths, function names, error messages and source references:
## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context`
