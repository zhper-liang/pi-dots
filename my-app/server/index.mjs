import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createApiServer } from './app.mjs'
import { readConfig, readExecutionDefaults } from './config.mjs'
import { openTaskStore } from './tasks.mjs'
import { listBots } from './bots.mjs'
import { readModelConfig, createModelReply } from './model-reply.mjs'

let tasks
try {
  const config = readConfig()
  // Stable default independent of the shell cwd; tests may use a temporary DB.
  const file = process.env.PIDOT_DB_PATH
    ? resolve(process.env.PIDOT_DB_PATH)
    : fileURLToPath(new URL('../data/pidot.sqlite', import.meta.url))
  const modelConfig = await readModelConfig()
  tasks = await openTaskStore({ file, workspaceEnabled: process.env.PIDOT_WORKSPACE_ENABLED !== '0', workspaceMigration: process.env.PIDOT_WORKSPACE_MIGRATION, bots: listBots(modelConfig, readExecutionDefaults()), modelReply: createModelReply(modelConfig), detectorOptions: { autoStart: true, onError: () => console.error('detector pass failed') } })
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
  server.listen(config.port, config.host, () => {
    console.log(`Pidot：http://${config.host}:${config.port}（Task 持久化对话；新会话${modelConfig ? '使用真实模型' : '使用测试模式'}）`)
  })
  function stop() {
    console.log('正在停止 Pidot…')
    server.close(async () => {
      try { await tasks.close(); process.exitCode = 0 }
      catch { console.error('存储关闭失败。'); process.exitCode = 1 }
    })
    server.closeIdleConnections()
    setTimeout(() => server.closeAllConnections(), 1000).unref()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  if (tasks) await tasks.close()
  // Do not expose provider configuration, filesystem paths, or SQL diagnostics.
  console.error(error.message?.startsWith('PIDOT_') ? `配置错误：${error.message}` : 'Pidot 启动失败，请检查本地数据库及配置。')
  process.exitCode = 1
}
