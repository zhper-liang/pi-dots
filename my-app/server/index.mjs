import { createExternalMcpService } from './external-mcp.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createApiServer } from './app.mjs'
import { readConfig, readExecutionDefaults } from './config.mjs'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { createModelSettings } from './model-settings.mjs'
import { SKILL_DIRECTORY, skillCapabilityCatalog } from './skills.mjs'
import { createSkillImportService } from './skill-import.mjs'
import { openGoogleConnection } from './google-connection.mjs'

let tasks, externalMcp, google
try {
  const config = readConfig()
  // R2 file memory is on by default; PIDOT_MEMORY_FILES=0 is the rollback switch (imports unsynced hand edits once).
  const memoryLearningFlag = process.env.PIDOT_MEMORY_LEARNING ?? '1'
  if (!['0', '1'].includes(memoryLearningFlag)) throw new Error('PIDOT_MEMORY_LEARNING 只能是 0 或 1。')
  const memoryFilesFlag = process.env.PIDOT_MEMORY_FILES ?? '1'
  if (!['0', '1'].includes(memoryFilesFlag)) throw new Error('PIDOT_MEMORY_FILES 只能是 0 或 1。')
  const continuousFlag = process.env.PIDOT_CONTINUOUS_TASKS ?? '1'
  if (!['0', '1'].includes(continuousFlag)) throw new Error('PIDOT_CONTINUOUS_TASKS 只能是 0 或 1。')
  // Stable default independent of the shell cwd; tests may use a temporary DB.
  const file = process.env.PIDOT_DB_PATH
    ? resolve(process.env.PIDOT_DB_PATH)
    : fileURLToPath(new URL('../data/pidot.sqlite', import.meta.url))
  const modelSettings = createModelSettings({ file })
  const modelConfig = await modelSettings.read()
  const skillImport = createSkillImportService({ dataDirectory: join(dirname(file), 'skills') })
  const skillDirectory = { builtinDirectory: SKILL_DIRECTORY, userSkills: skillImport }
  // R3-02: fixed Google hosts; client config by ADR-016 order (env, my-app/.env, root .env, then the settings file).
  google = await openGoogleConnection({ dataDirectory: join(dirname(file), 'google') })
  externalMcp = await createExternalMcpService({ dataDirectory: join(dirname(file), 'external-mcp'), googleAccessToken: options => google.accessToken(options), googleRejectToken: token => google.rejectToken(token) })
  tasks = await openTaskStore({ file, r4Migration: true, skillDirectory, externalMcp, google, capabilityManagementEnabled: true, continuousEnabled: continuousFlag === '1', readCapabilityCatalog: tx => skillCapabilityCatalog(skillDirectory, { tx }), workspaceEnabled: process.env.PIDOT_WORKSPACE_ENABLED !== '0', workspaceMigration: process.env.PIDOT_WORKSPACE_MIGRATION, bots: listBots(modelConfig, readExecutionDefaults()), modelSettings, memoryOptions: { enabled: memoryLearningFlag === '1' }, memoryFiles: { enabled: memoryFilesFlag === '1', root: join(dirname(file), 'bot-workspaces') }, detectorOptions: { autoStart: true, onError: () => console.error('detector pass failed') } })
  const server = createApiServer({
    token: config.token, tasks, onError: console.error,
    staticDir: fileURLToPath(new URL('../dist/', import.meta.url)),
  })
  server.on('error', async (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `端口 ${config.port} 已被占用，请停止原服务或修改 PIDOT_API_PORT。`
      : `本地 API 启动失败（${error.code ?? 'UNKNOWN'}）。`)
    await tasks.close()
    process.exitCode = 1
  })
  // Counts only: no paths or content in logs. Printed after the ready line, which tests treat as readiness.
  const memoryFileSummary = tasks.memoryFiles?.summary()
  server.listen(config.port, config.host, () => {
    process.nextTick(() => console.log(memoryFileSummary ? `记忆文件：${memoryFileSummary.targets} 份，已同步 ${memoryFileSummary.synced}，被拒绝 ${memoryFileSummary.rejected}，待写入 ${memoryFileSummary.pending}` : '记忆文件：已关闭（PIDOT_MEMORY_FILES=0），仅使用内部记录。'))
    console.log(`Pidot：http://${config.host}:${config.port}（Task 持久化对话；新会话${modelConfig ? '使用真实模型' : '使用测试模式'}）`)
    // Only an interactive terminal gets the token; redirected logs and service journals never do.
    if (process.stdout.isTTY) console.log(`本地访问 token：${config.token}`)
  })
  function stop() {
    console.log('正在停止 Pidot…')
    server.close(async () => {
      try { await tasks.close(); await google?.close(); process.exitCode = 0 }
      catch { console.error('存储关闭失败。'); process.exitCode = 1 }
    })
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 1000).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  if (tasks) await tasks.close()
  else await externalMcp?.close()
  await google?.close()
  // Do not expose provider configuration, filesystem paths, or SQL diagnostics.
  console.error(error.message?.startsWith('PIDOT_') ? `配置错误：${error.message}` : 'Pidot 启动失败，请检查本地数据库及配置。')
  process.exitCode = 1
}
