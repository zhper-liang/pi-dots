# 现状核对

## 已确认

- 工作区已有大量未提交变更，计划以当前文件为准。
- 现行架构要求模型配置按 Task 固定、能力按每次调用实时读取。
- 「日程与待办」工具集已承担本地与外部来源能力分配，固有能力不在开关内。
- `report_blocker` 当前提供单问题文本与回答，并会让 Task 进入等待状态。
- `Findings.tsx` 仍有「同时让 pipi 能查看本地待办和日程（只读）」入口。
- `WorkspaceStatus.tsx` 仍要求手动点击「读取存储状态」。

## 提问阻塞的确定原因

- `my-app/server/blockers.mjs`：问题只有 question / requiredInformation / assignee；`waitForBlocker` 只等待对应回答或停止，不消费新聊天消息。
- `my-app/server/tasks.mjs`：提问后进入 `awaitBlocker`，当前 ChatInput 仍被占用；`send()` 可继续入持久队列，但不能处理排在问题后面的消息。
- `my-app/server/steering.mjs`：`awaitBlocker` 显式拒绝插入并返回 `TASK_BLOCKED`。
- `my-app/src/App.tsx`：有待答问题时禁用插入和「转为插入」，普通发送显示「加入队列」。因此已确认的是消息不能及时被处理，不能据此断言所有状态下发送接口都失败。
- `my-app/src/TaskBlockerControls.tsx`：单文本框，只允许 activeId 对应的问题提交；无选项、多题、暂存或跳过语义。
- `my-app/server/task-context.mjs`：提示词明确要求缺必需信息就提问并等待，普通消息不作为回答。改交互时要同步更新运行契约。

## 能力即时生效的证据与不确定项

- `my-app/server/tools.mjs` 的 `toolSets()` 已实时读取 ToolAccess；`tasks.mjs` 在模型调用前重新生成工具定义，并有派发前复核。不能把问题直接归因为「后端全用旧快照」。
- `modelVisible()` 还按来源过滤工具；工作区工具还要经过 workspaceMcp 的可用性过滤。「勾选工具」不一定代表最终可调用。
- `my-app/src/BotCapabilities.tsx` 保存后只重读本面板，无 onChanged 通知聊天父组件；仅出错时出现「重新读取」。
- `my-app/src/App.tsx` 的工具标签按 botId 缓存；能力保存后的主动失效需要纳入核对。
- 对话配置已有 `pidot.capability-setup-status` 进入模型上下文，但普通能力开关是否具备等效的实时变化提示，需要实施阶段通过假模型抓取上下文确认。
- 没有重现用户的具体失败会话，也未访问正式数据；精确根因仍需按保存、来源分配、schema、派发四层回归定位。

## 重复入口与飞书

- `my-app/src/Findings.tsx` 的 AssistSettings 同时管理分析按钮和 chiefRead；`docs/interfaces/http-api.md` 仍记录 chiefRead:true 会追加本地工具与来源，不能只删文案。
- `my-app/src/SettingsPage.tsx` 在「连接」挂载 ExternalWorkspace、GoogleConnection、ExternalMcpConnections；高级里挂载 WorkspaceStatus。
- `my-app/src/BotTemplatePage.tsx` 的设置页另有 FeishuCalendarPanel；飞书绑定、来源许可、日程查询/修改散在不同面板。
- `my-app/src/WorkspaceStatus.tsx` 无自动加载；每次 refresh 清空数据，并同时调用 status 和 external-sources。
- `my-app/src/ExternalWorkspace.tsx` 已每 3 秒读取来源状态；`FeishuCalendarPanel.tsx` 另有独立的每 3 秒轮询。整合需复用刷新逻辑，避免额外叠加。

## 调研工具记录

- 一次路径检索包含不存在的 TaskChatControls.tsx / queue.mjs / messages.mjs，返回退出码 2；已改为实际的 App.tsx、tasks.mjs、steering.mjs，未影响源码判断。
- 大范围输出曾被截断，后续按组件和关键函数分段读取。

## 实施结果

- 用户截图指出原来源面板与工具集平级、来源开关与能力开关同形、刷新入口重复。验收反馈要求自动无感同步，不能仅把两个按钮合并成一个。后台失败不应清空同一身份下最后成功读取的内容；身份变化仍必须清空。
- 进一步检查发现 App 会话详情轮询在首次 GET 失败后 return，永久停止读取；已改为失败后逐次退避自动恢复（最高 15 秒），成功后恢复正常频率。暂时读取失败仅显示随恢复消失的会话内提示，401 仍走原断开逻辑。
- 已验证并修复前端保存后的状态失效通知缺口，工具标签不再按botId永久使用旧缓存；模型最终收到的schema和实时摘要一致。具体用户原失败会话未读取，不把该缺口宣称为唯一根因。
- 旧awaitBlocker保留兼容；有新消息时按输入挂起，旧模型/Skill/额度/摘要在恢复时回到原请求。
- 独立审查补充了失效问题编号错误回退、requestId精确绑定、关联子任务取消和内部恢复数据投影的回归。
- 上下文容量回归通过精简与去重固定提示解决，保留原模型容量和测试阈值。

- 统一日历验收发现：CalendarBoard 已聚合本地和外部来源，但来源仅在图例/详情及无障碍文字中，普通卡片不可见；现已补齐卡片来源标签。截止项原 key 只有 id，已改为 sourceId + id，避免跨来源同 ID 冲突。
- 本地 workspace:local 属于真实持久化数据，旧 mock:personal 才是模拟夹具；机器人提示现已明确区分，并要求按统一日历汇总结果。
