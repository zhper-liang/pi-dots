# 实施与规划进度

2026-11-01：用户要求生成下一阶段改进计划。沿用文件规划技能，在plans/backlog建立候选计划，避免把规划请求标为业务开工。已读NEXT_STAGE、现有计划与架构/接口，复核整理定时器、来源限制、主会话映射、记忆容量。既有工作区修改保留；未操作正式数据。

已整理上一轮Hermes官方研究的固定提交来源，区分内置记忆、历史检索、Skill、普通子Agent与后台回顾。正在细化六项实施票和验收矩阵。

补查确认：历史按Entry回读不等于跨会话搜索；Skill配置接口不等于学习内容写入接口；现有记忆注入是按时间截取。读取时曾猜测history-tools.mjs、task-history.mjs及ADR编号文件名导致路径不存在，已通过rg文件清单和实际import定位history-tool.mjs，改为准确路径；不影响业务文件。session-catchup未报告需恢复内容。

正文已完成：M01—M06含交付、代码落点、依赖、来源与失败处理，A01—A12覆盖端到端验收；区分用户已明确内容与推荐默认值。补充派生Task统一候选、直接私聊显式修改保留、后台作业不依赖旧主会话ID、学习Skill来源/所有者检查。已更新NEXT_STAGE、plans索引和前阶段链接，修正索引中遗留的30秒记录。正在做文档检查；本轮没有变更业务实现。

规划交付完成：7份相关文档、60个本地链接、6项实施票及12个验收场景检查通过，git diff --check通过。本轮为纯文档变更，未重新执行pnpm test/lint/build；1562项通过是先前代码基线，不是本轮新测试结果。所有实施票仍为planned，未提交、部署或操作正式库。

2026-11-01 实施开工：用户明确授权 6.1 Sol 子 Agent 完成全部计划，已移入 active/memory-learning 并登记边界。已读取 AGENTS/NEXT_STAGE 与计划，现存大量前阶段改动保留。负责人处理 M01—M03/core/M06，独立代理处理 M04 历史检索及 M05 学习 Skill。发现旧 worker 失败推进 cursor、全局 debounce 与旧 Task 模型快照均须修正，不能沿用。

实施里程碑：M01 同 Bot 来源、成功工具证据、文件纠正防复活已实现；M02 持久逐会话一小时、压缩/结果同事务登记、固定候选恢复、预算/退避/前台中止；M03 当前 Bot 模型统一后台回顾；M04 搜索/补读及相关性；M05 owner/source贯穿Skill版本与复用；M06 HTTP和前端状态、暂停/恢复/立即整理已接。新增7个M02 focused通过。独立负责人3个真实store端到端通过：派生Task成功→清主会话→落盘记忆/Skill→重启去重→新主搜索补读→来源删除撤回；失败/临时英文无沉淀；压缩原子登记即刻自动review原始证据。

独立1440/375界面检查通过：暂停持久、编辑可用、恢复/立即整理、偏好落盘状态和来源跳转，无横向溢出或pageerror。截图在 .scratch/memory-learning/{desktop-memory,mobile-memory,mobile-source}.png，已目视检查。隔离server未接Google/MCP，仅其相应状态503，不影响记忆流程；未验证真实模型学习质量。

整体验证中发现并修复：归档旧main父身份需readLifecycleSession恢复；状态投影需事务内深复制；目录事务需传tx防止嵌套commit；Task结果扫描需在finishReply首次表写入前完成，避免Harness ReadAfterWrite。旧测试中的全局失败cursor/no-tombstone/无关记忆注入假设按新契约改为可靠重试/防复活/相关查询，普通Task仍不扩权。两次focused命令从错误cwd启动导致fixture找不到，已改回my-app；不会当作业务失败或成功结果。首次全量1586测1571通过15失败，正在处理明确契约变更断言及上述Task结果扫描回归，不宣称完成。

最终收口（2026-11-01）：M01—M06已完整实现。最后一轮pnpm test1597/1597（49.09秒，0失败/跳过/取消）；pnpm lint通过，10条既有warning，无新增；pnpm build通过，保留既有>500kB chunk提示。独立负责人最新3条真实store验收通过，含合法activate后rules/reference确实进入下一prompt，删除来源后目录description、后台existing.memory/methods、活动规则/资料和摘要均无旧内容。1440/375截图已目视通过，隔离服务和浏览器均已关闭。最后补三文档实际占用元信息，build再次通过。

新增保护均有回归：旧v1 jobs幂等迁移隔离（保留quota和ready cursor，失败refs重试不整库回学）；跨UTC持久proposal仅结算原日原笔reservation；扫描期间新提交标记dirty补扫；prepared/proposed/waiting/preview不算成功；同一显式subject矛盾事实保留现状并需核实；提交前失败与已提交后未确认两种真实SQLite reopen均不再生成或重复写版本。M05另修移除墓碑/禁用解绑不自动重开、CRDT证据安全复制、当前input撤权后资料回执/派生摘要不回放。

证据留在.scratch/memory-learning/：test-final.log、lint-final.log、build-final.log、desktop-memory.png、mobile-memory.png、mobile-source.png。未连接真实模型/账户；这些结果只证明控制流与边界，不代表真实长期学习质量获得用户验收。未操作my-app/data/、正式迁移/服务重启、新依赖、提交或推送。工作区前阶段改动完整保留；计划保持active待用户验收。

最终文档检查：15份Markdown、149个本地链接全部有效，git diff --check通过。末次lint日志收尾命令曾误用zsh只读变量status；换task_lint_exit后再次确认退出0及10条既有warning，不影响业务文件。
