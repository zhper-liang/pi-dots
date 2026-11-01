export type SourceConfiguration = {
  bot: { description: string; configRef: { version: string } }
  assigned: { tools: string[]; resources: string[] }
  resources: string[]
  resourceLabels?: Record<string, { title: string; note: string }>
}
export type SourceRow = { id: string; resources: string[]; title: string; note: string; enabled: boolean; partiallyEnabled: boolean }
export function scheduleSourceRows(configuration: SourceConfiguration): SourceRow[]
export function sourceAssignment(configuration: SourceConfiguration, row: SourceRow, enabled: boolean, requestId: string): { expectedVersion: string; requestId: string; description: string; tools: string[]; resources: string[] }
