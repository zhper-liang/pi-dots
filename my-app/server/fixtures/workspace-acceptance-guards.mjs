// Acceptance-only guards. Never imported by the production server.
import assert from 'node:assert/strict'

export function createModelObservation() {
  let calls = 0, active = 0, observation
  return {
    get calls() { return calls },
    get snapshot() { return observation && { ...observation, modelDelta: calls - observation.before } },
    async invoke(fn) {
      // Do not permit an observer's own model call to contaminate this interval.
      if (observation && !observation.endedAt) observation.attempts++
      assert(!observation || observation.endedAt, 'Model invocation forbidden during zero-model observation')
      calls++; active++
      try { return await fn() } finally { active-- }
    },
    begin() {
      assert.equal(active, 0, 'All model requests must settle before observation')
      assert(!observation, 'Observation may begin only once')
      observation = { startedAt: new Date().toISOString(), before: calls, attempts: 0 }
      return this.snapshot
    },
    finish() {
      assert(observation && !observation.endedAt, 'No active observation')
      assert.equal(active, 0); assert.equal(calls, observation.before)
      assert.equal(observation.attempts, 0, 'Any model attempt invalidates zero-model observation')
      observation.endedAt = new Date().toISOString()
      return this.snapshot
    },
  }
}

export function assertLiveEventRetained({ before, after, writesBefore, writesAfter }) {
  assert(before && !before.deletedAt, 'Verify Event live before Todo deletion')
  assert(after && !after.deletedAt, 'Event must remain live after Todo deletion')
  for (const field of ['id', 'sourceId', 'remoteId', 'version', 'remoteVersion']) assert.equal(after[field], before[field], `Event ${field} must remain unchanged`)
  assert.equal(writesAfter, writesBefore, 'Deleting Todo must not write provider')
}
