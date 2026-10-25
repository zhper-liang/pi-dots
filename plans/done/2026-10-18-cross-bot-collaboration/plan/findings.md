> **归档说明**：本文是计划当时的原文，未改写。文中 `issues/`、`progress/`、`evidence/` 等相对链接指向原始实施目录，原始票据、日志与验收证据保留在本地 `.scratch/`，不随本仓库分发；已归档到仓库外的备份仓库 `~/code/pidot-history-backup-20261025.git`（用 `git --git-dir=<备份> show HEAD:<路径>` 可取回）。

# 拆票依据与发现

- 上轮建议已得到本次“直接做票”授权；可自行决定少量纵向切片，不需要用户再次确认。
- 多Bot与Chief管理六票已完成，486项回归与真实模型联合验收仅为既有基线，本轮未运行。
- 下一路线为产品第3–6步：一层委派、协作黑板、阻塞升级/恢复、结果验收和可见责任链；第7步真实连接器、定时、推送仍不提前。
- 复用Harness Task/conversation/Document与既有运行保护，不另建执行状态机；Chief管理权限不等于任务主管权限。
- 现有本地tracker一票一文件，使用What to build/Blocked by/Status及可测试验收；ready-for-agent不等于前置完成或开发授权。
- 用户此前要求合并过细的票，本轮保持少量完整行为切片；必要网页和测试随每票交付，安全不延期到联合验收。
- 受保护基线与上一份NEXT_STAGE副本见progress/evidence/ticket-publication/。

## 源码核对（仅本地读取）
- 既有TaskCard、ChatInput、ChatQueue均为Harness Document；当前Task对话和FIFO/插入控制应继续复用，不能通过共享长期会话假装子任务隔离。
- report_blocker目前仅允许assignee=user，回应API绑定原Task/事项/输入/检查点；03须扩展“主管处理→转用户→恢复”的关联，不误认为已支持主管处理。
- buildTaskContext校验conversation归属，并过滤参与当前输入的历史；跨Task结果和笔记须作为带来源的数据显式注入，不能放开整段他人历史。
- 工具层已有许可快照、实时能力检查、调用预算与Chief管理校验；新协作入口不应放宽这些约束。
- 运行架构明确delegate保留Bot创建/管理含义。任务委派工具必须使用不同名称，不能重定义delegate；票据不强行指定最终API名。
- 产品设想带version的Zod schema，但当前package.json没有直接声明zod。发布不新增依赖；实现优先复用已批准校验能力，若确需新直接依赖必须单独提交用户确认，不因拆票暗批。
- 子Task创建不应继承主管的工具、审批或Skill授权；沿用执行者自身不可变配置/权限快照及实时撤权。旧Task不因新增协作功能自动扩权，使用新会话或既有显式安全迁移入口。
- 本阶段实现私聊入口的一层协作与子线程可见性；完整GroupChat/@、同步consult及历史fork不是本轮票承诺，不宣称完成所有产品协作形态。

## 发布后验证
六票共47条未勾选验收；直接阻塞与阶段矩阵一致，唯一初始frontier为01。文档本地链接和旧交接根路径链接检查通过；917份源码/依赖及旧阶段/规范/证据文件哈希未变。当前入口已切换到新阶段，旧六票保持completed；业务测试本轮未执行。

## 01实施发现（2026-10-18）
- 创建收敛至task-creation；调用保持内部根conversation，独立用户conversation仍由每个Task拥有；不是Harness child ownership共享用户历史。
- pidot.collaboration v1 session Document持久关系/回执；执行只用现有Harness awaitChildren/watchDoc。session watchDoc无undefined占位；取消Task数据依旧走既有archive。
- 结果父inReplyTo必须在展开子结果后绑定；新增测试断言主管真正看到子正文，不仅有关系卡。稳定操作重放只回必要元数据，不绕过结果回读许可。
- 主管/执行者派发及结果回读均即时查许可与停用；根取消后迟到结果可存档，不驱动主管。
- 最终65专项/498全量/lint/build/真实模型网页与SIGKILL通过；详见../progress/evidence/01/README.md。不重复引用旧486作为本轮。

## 02实施发现（2026-10-18）
- 01每次task_assign后会进入原生awaitChildren，不能假定模型下一轮可在B执行前追加分享；task_assign可选sharedRecords复用主管受控授权并和创建原子提交。Harness表写后不能读取Task，必须先校验来源/权限/版本。
- 共享工具正文不能随历史回放绕过当前ACL，但稳定ID/版本/操作/错误元数据必须保留，否则模型会重复发布。当前可读正文另行轻量注入，并在派发前校验版本。
- 旧Task不能无条件追加新系统提示；共享提示仅在授权共享工具的Task启用，避免改变原压缩容量行为。
- 来源资源与派生记录共同约束，分享不等于资源授权；撤回不能撤销模型已读内容或其自有回答的历史。
- 本轮78专项、507全量、lint/build、真实A→主管→B、异根拒绝、同库SIGKILL通过，详见02证据。不重开01或启动03。

## 03实施发现（2026-10-18）
- 子Task报告问题必须按服务端关系先交主管；主管并非Chief管理身份，受控工具与固定/实时许可共同限制。用户回答严格版本/根工作/原输入绑定，转交不会创建第二事项。
- awaitChildren提前collect会吞掉阻塞通知；reply统一交付，持久待处理标记保留通知到模型实际处理，watchDoc无忙轮询。通知notify(user,event)是页内持久upsert，不是外部推送。
- 主管中间信息报告不能结束原输入：必须等子结果真正consumed，收尾检查存在未收关系，不清槽。相同phase续跑必须标记检查点进展，否则Harness正确判faulted。真实验收暴露问题后新隔离库重验，失败证据保留。
- 单Task既有兼容语义允许保存信息后由原工具撤权守卫拒绝执行；协作路径额外检查全责任链。信息回答从不创建操作批准或转移权限/额度。
- 本轮86专项/516全量、lint/build、真实两分支、SIGKILL恢复及1440/390完成，见03证据。下一窗口04，05/06仍阻塞；不重开旧票。

## 04实施发现（2026-10-18）
- 有task_review固定快照的新工作必须显式接受必需子结果；旧Task不能为新功能自动加权。提交/收取不是accept，口头“完成”不清原输入。
- 同Task返工重新激活原childInputId，直接保留工具/审批历史和累计预算；用户消息/插入/迁移不能另开受管工作。
- 审计事件不能以user文本插入assistant tool_call与tool_result之间；真实供应商会拒绝消息配对。决定已有真实工具回执，额外只存审计/网页，不重复注入。
- Harness Document为代理，不能直接structuredClone；快照沿用JSON复制。运行ESM边界用方法内动态导入防工具注册初始化环。
- 取消子Task会合法唤醒主管收取cancelled；竞态断言须等父收取/结束原输入后再检验静止，子调用始终不可新增。
- 最终156专项/530全量、lint/build、真实两版返工/精确accept、同库SIGKILL和1440/390通过；见04证据。下一窗口05，不开06。

## 05实施发现（2026-10-18）
- 根停止是Collaboration v1关系控制意图，不是第二执行状态机；先commit意图，resume前逐Task补传播。Harness append后不能读Task表，故不可在多Task取消事务中边读边append。
- 根取消与长期Task取消不同；结束原输入须退该输入Blocker/审批/插入锁，保留未知动作审计；模型上下文跳过已停止根及迟到工具turn，避免新普通工作恢复旧指令或破坏call/result协议。
- 停用父也须中断关联子信号；持久watch同时监听根停止，使停用/撤权park仍可安全执行用户停止，不开启模型。stale重复旧root仅中断同root controller，不误伤第二工作。
- 不能重定义旧独立Task的Blocker取消归档语义；只对协作子Task新增取消状态，展示层按根停止投影并保留历史正文。
- 真实browser CLI run-code等待可能提早返回，不能把即时usage采样失败当产品失败；独立持久状态轮询与最终严格校验才算验收。CLI确认框先触发再dialog-accept，避免互相等待。
- 本轮22新增、210专项、552全量，真实同父两根/定向停止/取消回报及同库SIGKILL通过，见05证据。下一窗口06，不重开旧票。

## 06联合发现（2026-10-18）
- 单次review测试不够：已收取submitted结果后主管先shared_read再review，collect不能提前park；只等实际未完成执行者，finishInput继续禁止未accept整体完成。
- accepted是子工作业务终态，不是Harness长期Task终态；空闲awaitInput重启必须保留可读Task文档。活动输入仍禁止越过accepted，新增同库回归。
- seed目录缺status按既有定义active；概览不得以缺值误报停用，图像审查发现并补断言。
- 共享来源资源/工具共同约束真实路径；显式为新主管/读者赋予同底层只读许可，不绕ACL或给旧Task补权。
- 真模型SIGKILL合法新增原生waiting恢复审计；idle running→pending调度差异不等于业务状态变化。对业务Document、身份、用量、共享版本、决定/副作用严格比较。
- 本轮最终559全量/343专项、真实两路径/网页/SIGKILL通过；供应商一次失败Task73 unknown1仍保留，成功另建重验126，不能清账或冒称所有模型尝试成功。详见06证据。六票完成，无下一票。
