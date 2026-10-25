// View changes do not invalidate a request. Permission/source changes and disposal do.
export function createWorkspaceRequestGuard() {
  let identity = '', revision = 0, sequence = 0
  return {
    identity(next) { if (identity !== next) { identity = next; revision++; sequence++ } },
    invalidate() { revision++; sequence++ },
    capture() { return revision },
    sameIdentity(ticket) { return ticket === revision },
    begin() { return { revision, sequence: ++sequence } },
    current(ticket) { return ticket.revision === revision && ticket.sequence === sequence },
  }
}
