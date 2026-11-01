// Pure tool schemas: no runtime Documents or service imports.
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value)
const revision = value => Number.isSafeInteger(value) && value >= 1
const validContinuousEvidenceRef = value => object(value) && (value.kind === 'child-result'
  ? Object.keys(value).every(key => ['kind', 'relationId', 'revision'].includes(key)) && typeof value.relationId === 'string' && value.relationId.length > 0 && value.relationId.length <= 180 && revision(value.revision)
  : Object.keys(value).every(key => ['taskId', 'entryId'].includes(key)) && revision(value.taskId) && revision(value.entryId))
const refs = value => Array.isArray(value) && value.length > 0 && value.length <= 40 && value.every(validContinuousEvidenceRef)
const refSchema = { oneOf: [{ type: 'object', additionalProperties: false, required: ['taskId', 'entryId'], properties: {
  taskId: { type: 'integer', minimum: 1 }, entryId: { type: 'integer', minimum: 1 } } },
{ type: 'object', additionalProperties: false, required: ['kind', 'relationId', 'revision'], properties: {
  kind: { const: 'child-result' }, relationId: { type: 'string', minLength: 1, maxLength: 180 }, revision: { type: 'integer', minimum: 1 } } }] }
const refList = { type: 'array', minItems: 1, maxItems: 40, items: refSchema }
const request = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,120}$' }
const revSchema = { type: 'integer', minimum: 1 }
const stepSchema = { type: 'object', additionalProperties: false,
  required: ['stepId', 'title', 'dependsOn', 'deliverable', 'verification', 'criteriaIndices'], properties: {
    stepId: request, title: { type: 'string', minLength: 1, maxLength: 160 }, dependsOn: { type: 'array', maxItems: 32, uniqueItems: true, items: request },
    deliverable: { type: 'string', minLength: 1, maxLength: 1200 }, verification: { type: 'string', minLength: 1, maxLength: 1200 },
    criteriaIndices: { type: 'array', minItems: 1, maxItems: 40, uniqueItems: true, items: { type: 'integer', minimum: 0 } } } }
const tool = (name, description, required, properties) => ({ name, description, parameters: { type: 'object', additionalProperties: false, required, properties } })

export const CONTINUOUS_TOOLS = Object.freeze(['work_plan', 'work_submit', 'work_complete'])
export const continuousTools = Object.freeze([
  tool('work_plan', '维护当前持续目标的阶段计划，选择可执行的下一步。不能更改用户目标、限制或完成标准；步骤ID稳定，依赖无环；已提交成果不能覆盖。requestId稳定重试，expectedPlanRevision使用当前版本。',
    ['requestId', 'expectedPlanRevision', 'goalRevision', 'steps', 'currentStepId'], {
      requestId: request, expectedPlanRevision: { type: 'integer', minimum: 0 }, goalRevision: revSchema,
      steps: { type: 'array', minItems: 1, maxItems: 32, items: stepSchema }, currentStepId: request,
    }),
  tool('work_submit', '提交当前阶段成果及真实宿主证据引用，只进入submitted，不会自验收或结束目标。使用当前目标/计划修订，引用实际taskId/entryId或绑定子结果。工具成功只证明其契约范围，失败、未知、未批准或未读正文不是完成证据。',
    ['requestId', 'stepId', 'goalRevision', 'planRevision', 'summary', 'evidenceRefs'], {
      requestId: request, stepId: request, goalRevision: revSchema, planRevision: revSchema,
      summary: { type: 'string', minLength: 1, maxLength: 4000 }, evidenceRefs: refList,
    }),
  tool('work_complete', '请求宿主逐条检查整个目标。不能直接结束目标或降低标准；执行阶段请求必须经过独立评审阶段。逐项引用真实成果，说明核验理由和主观质量判断；缺口返回后继续补齐。不是用户授权。',
    ['requestId', 'goalRevision', 'planRevision', 'stepId', 'submissionRevision', 'criteriaEvidence', 'summary'], {
      requestId: request, goalRevision: revSchema, planRevision: revSchema, stepId: request, submissionRevision: revSchema,
      summary: { type: 'string', minLength: 1, maxLength: 4000 }, criteriaEvidence: { type: 'array', minItems: 1, maxItems: 40,
        items: { type: 'object', additionalProperties: false, required: ['index', 'verdict', 'reason', 'evidenceRefs'], properties: {
          index: { type: 'integer', minimum: 0 }, verdict: { type: 'string', enum: ['satisfied', 'unsatisfied', 'needs-review'] },
          reason: { type: 'string', minLength: 1, maxLength: 2000 }, evidenceRefs: refList,
        } } },
    }),
])

export function validContinuousCall(call) {
  const a = call?.arguments
  if (call?.argumentsError || !id(a?.requestId) || !revision(a?.goalRevision)) return false
  if (call.name === 'work_plan') return keys(a, ['requestId', 'expectedPlanRevision', 'goalRevision', 'steps', 'currentStepId']) &&
    Number.isSafeInteger(a.expectedPlanRevision) && a.expectedPlanRevision >= 0 && id(a.currentStepId) && Array.isArray(a.steps) && a.steps.length > 0 && a.steps.length <= 32 && a.steps.every(step =>
      keys(step, stepSchema.required) && stepSchema.required.every(key => Object.hasOwn(step, key)) && id(step.stepId) && text(step.title, 160) &&
      text(step.deliverable, 1200) && text(step.verification, 1200) && Array.isArray(step.dependsOn) && step.dependsOn.length <= 32 &&
      step.dependsOn.every(id) && new Set(step.dependsOn).size === step.dependsOn.length && Array.isArray(step.criteriaIndices) &&
      step.criteriaIndices.length > 0 && step.criteriaIndices.length <= 40 && step.criteriaIndices.every(index => Number.isSafeInteger(index) && index >= 0) &&
      new Set(step.criteriaIndices).size === step.criteriaIndices.length)
  if (!revision(a.planRevision) || !id(a.stepId)) return false
  if (call.name === 'work_submit') return keys(a, ['requestId', 'stepId', 'goalRevision', 'planRevision', 'summary', 'evidenceRefs']) && text(a.summary, 4000) && refs(a.evidenceRefs)
  return call.name === 'work_complete' && keys(a, ['requestId', 'goalRevision', 'planRevision', 'stepId', 'submissionRevision', 'criteriaEvidence', 'summary']) &&
    revision(a.submissionRevision) && text(a.summary, 4000) && Array.isArray(a.criteriaEvidence) && a.criteriaEvidence.length > 0 && a.criteriaEvidence.length <= 40 &&
    a.criteriaEvidence.every(row => keys(row, ['index', 'verdict', 'reason', 'evidenceRefs']) && Number.isSafeInteger(row.index) && row.index >= 0 &&
      ['satisfied', 'unsatisfied', 'needs-review'].includes(row.verdict) && text(row.reason, 2000) && refs(row.evidenceRefs))
}

