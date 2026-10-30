# R3-05 workspace-mcp 运维说明

> 2026-10-31，R3-05 交付。适用 workspace-mcp **2.2.1**（uv tool 安装，固定版本）。本机和服务器用同一组参数和环境变量。Pidot 只负责 Google 登录、转交令牌和对话接入，不启动也不守护 workspace-mcp（README §6 R3-05「不做」）。

## 1. 按 2.2.1 源码核实的结论

源码目录：`~/.local/share/uv/tools/workspace-mcp/lib/python3.13/site-packages/`。行号对应 2.2.1。

| 项 | 结论 | 依据 |
|---|---|---|
| 监听地址 | OAuth 2.1 模式下**默认 0.0.0.0**，只有显式设 `WORKSPACE_MCP_HOST=127.0.0.1` 才只监听本机 | `main.py:206-232`（`resolve_bind_host_for_transport`：开启 OAuth 2.1 时直接返回 `WORKSPACE_MCP_HOST or "0.0.0.0"`）；实测见 §5 |
| 端口 | `PORT` 优先于 `WORKSPACE_MCP_PORT`，默认 8000 | `main.py:723-726`、`core/config.py:34-39`。systemd 环境里不要有别的 `PORT` |
| `--permissions` 与 `--tool-tier` | 可以同用：先按层级取工具，再按权限去掉需要未授予 scope 的工具。`--permissions` 与 `--tools`、`--read-only` 互斥 | `main.py:381-395`、`main.py:701-717`、`main.py:780-807`、`core/tool_registry.py:139-221` |
| 实际工具 | 41 个，见 §6。extended 层级 Gmail 里的 `modify_gmail_message_labels`、`manage_gmail_label`、`list_gmail_filters`、`manage_gmail_filter` 因缺 labels/modify/settings scope 被去掉 | 离线实测（§5） |
| 工具用请求里的 bearer 访问 Google | 成立。`ya29.*` 令牌每次请求经 Google userinfo 校验；工具里的 Google 凭据就是这次请求的访问令牌，没有 refresh token，外部模式不写会话存储 | `auth/external_oauth_provider.py:227-321`（userinfo 校验）；`fastmcp/server/http.py:679-710`（`/mcp` 套 `RequireAuthMiddleware`，校验失败直接 401，工具不执行）；`auth/service_decorator.py:409-468` → `auth/oauth21_session_store.py:1145-1206`（`Credentials(token=access_token.token, refresh_token=None)`，`is_external_oauth21_provider()` 时不存会话） |
| scope 检查 | 外部模式下 workspace-mcp 自己的 scope 检查不起作用（令牌的 scopes 直接填成它要求的全部 scope），真正的限制是 Google 对缺 scope 的请求返回 403 | `external_oauth_provider.py:204-216`、`service_decorator.py:454-461` |
| 校验缓存 | 默认关闭：每个 MCP 请求都调用一次 userinfo。`WORKSPACE_MCP_TOKEN_VALIDATION_CACHE_TTL`（上限 300 秒）可开，代价是撤销后的令牌在缓存期内仍能过本地校验 | `external_oauth_provider.py:98-124` |
| 启动需要的秘密 | **主管核实的“外部模式不要密钥”只对一半**：不要 Google client secret，但没有 secret 时必须设 `FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY`，否则启动报错退出。随机生成即可，与 Google 无关 | `core/server.py:633-655`、`core/server.py:778-782`；实测报错 `Public client OAuth 2.1 requires FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY when GOOGLE_OAUTH_CLIENT_SECRET is not set.` |
| `GOOGLE_OAUTH_CLIENT_ID` | 必须非空（`main.py:235-248`）。`ya29.*` 走 userinfo，不核对令牌属于哪个客户端；填 Pidot 用的同一个 ID 即可 | `auth/oauth_config.py:397-404` |
| 无状态模式 | 建议开 `WORKSPACE_MCP_STATELESS_MODE=true`：不建会话、不写凭据目录和调试日志文件，并隐藏读本机文件的 `file_path` 参数（防止模型让它读服务器上的文件再上传） | `core/utils.py:177-186`、`core/log_formatter.py:198-219`、`main.py:956-979` |
| 启动时联网 | 不联网。遥测只在设了 `OTEL_EXPORTER_OTLP_ENDPOINT`/`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` 时启用；FastMCP 的版本检查只在显示横幅时运行，而 workspace-mcp 用 `show_banner=False` 启动 | `core/telemetry.py:75-131`、`main.py:1056-1062`、`fastmcp/utilities/version_check.py:132-145`；另设 `FASTMCP_CHECK_FOR_UPDATES=off` 兜底 |
| 健康检查 | `GET /health` 不需要认证，返回 `{"status":"healthy","service":"workspace-mcp","version":"2.2.1"}`；设置页用它判断是否在运行 | `core/server.py:903-917` |

## 2. 环境文件

`~/.config/workspace-mcp/env`（目录 0700，文件 0600），本机和服务器内容相同（签名密钥可以各自生成）：

```sh
MCP_ENABLE_OAUTH21=true
EXTERNAL_OAUTH21_PROVIDER=true
WORKSPACE_MCP_STATELESS_MODE=true
WORKSPACE_MCP_HOST=127.0.0.1
WORKSPACE_MCP_PORT=8000
GOOGLE_OAUTH_CLIENT_ID=<与 Pidot 设置页相同的客户端 ID>
FASTMCP_SERVER_AUTH_GOOGLE_JWT_SIGNING_KEY=<随机串，例如 openssl rand -hex 32 的输出>
FASTMCP_CHECK_FOR_UPDATES=off
```

不要设 `GOOGLE_OAUTH_CLIENT_SECRET`、`PORT`、`OTEL_*`、`WORKSPACE_MCP_TOOLS`、`WORKSPACE_MCP_READ_ONLY`。

Pidot 一侧：端口不是 8000 时，在 `my-app/.env` 设 `PIDOT_WORKSPACE_MCP_URL=http://127.0.0.1:<端口>/mcp`（只接受本机地址；`dev:api`/`start:api` 用 `--env-file-if-exists=.env` 读 `my-app/.env`，根 `.env` 不读这一项）。这个地址只在服务端配置，不存进连接配置，模型和界面都改不了。

## 3. 本机启动

```sh
uv tool install workspace-mcp==2.2.1     # 已装则跳过；不用 uvx 浮动启动
set -a; . ~/.config/workspace-mcp/env; set +a
~/.local/bin/workspace-mcp --transport streamable-http \
  --permissions gmail:readonly+drafts+send drive:full docs:full sheets:full --tool-tier extended
```

检查：`curl -s http://127.0.0.1:8000/health` 返回 `"service":"workspace-mcp"`；`ss -ltn | grep 8000` 只应看到 `127.0.0.1:8000`。

## 4. 服务器 systemd（用户单元，参数与 §3 相同）

`~/.config/systemd/user/workspace-mcp.service`：

```ini
[Unit]
Description=workspace-mcp 2.2.1 for Pidot (loopback only)
After=network-online.target

[Service]
EnvironmentFile=%h/.config/workspace-mcp/env
ExecStart=%h/.local/bin/workspace-mcp --transport streamable-http --permissions gmail:readonly+drafts+send drive:full docs:full sheets:full --tool-tier extended
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now workspace-mcp
loginctl enable-linger "$USER"     # 服务器上未登录时也常驻
```

## 5. 本轮实测（不登录、不联网）

- 在 `unshare -rn`（只有 loopback 的网络命名空间）里启动真二进制：默认 `0.0.0.0:<端口>`，设 `WORKSPACE_MCP_HOST=127.0.0.1` 后 `127.0.0.1:<端口>`；`/health` 200；`/mcp` 无令牌 401，假 `ya29.*` 令牌 401（日志显示它去连 `www.googleapis.com` 校验，在命名空间里失败）。没有登录，没有调用任何工具。
- 工具目录：同一命名空间里用 2.2.1 自己的 `main()` 和上述参数注册工具，经 FastMCP 内存客户端列出（不走 HTTP、不校验令牌）。结果存为 `my-app/server/fixtures/fake-workspace-mcp-tools.json`，假服务原样使用。共 41 个工具、约 88 KB，在 Pidot 的上限内（单页 64 个、目录 512 KB、单个 schema 32 KB），全部 schema 能被 Ajv 编译。
- 重新生成：探测脚本留在本地未入库的 `.scratch/2026-10-30-r3-05/`（`list_tools.py` 换掉 `server.run` 后列工具，`run-binary.sh` 做绑定、健康检查和 401 检查），都在 `unshare -rn` 里运行，`HOME` 指向临时目录。

## 6. 工具清单（41 个）与多出来的部分

Gmail（8）：`search_gmail_messages`、`get_gmail_message_content`、`get_gmail_messages_content_batch`、`get_gmail_thread_content`、`get_gmail_attachment_content`、`list_gmail_labels`、`draft_gmail_message`、`send_gmail_message`。
Drive（14）：`search_drive_files`、`list_drive_items`、`get_drive_file_content`、`get_drive_file_download_url`、`create_drive_file`、`create_drive_folder`、`copy_drive_file`、`update_drive_file`、`import_to_google_doc`、`import_to_google_sheets`、`import_to_google_slides`、`get_drive_shareable_link`、`manage_drive_access`、`set_drive_file_permissions`。
Docs（12）：`get_doc_content`、`get_doc_as_markdown`、`search_docs`、`list_docs_in_folder`、`create_doc`、`modify_doc_text`、`find_and_replace_doc`、`insert_doc_elements`、`update_paragraph_style`、`export_doc_to_pdf`、`list_document_comments`、`manage_document_comment`。
Sheets（7）：`list_spreadsheets`、`get_spreadsheet_info`、`read_sheet_values`、`modify_sheet_values`、`create_spreadsheet`、`format_sheet_range`、`list_sheet_tables`。

超出 D3/D5/D6 字面的：共享与权限（`manage_drive_access`、`set_drive_file_permissions`、`get_drive_shareable_link`）、样式（`update_paragraph_style`、`format_sheet_range`、`insert_doc_elements`）、评论（`list_document_comments`、`manage_document_comment`）、`import_to_google_slides`。要屏蔽就在 §3/§4 两处命令末尾加同样的 `--disabled-tools <名字…>`。41 个工具的说明每轮都会进模型上下文，屏蔽也能省 token。

## 7. 迁到服务器（README §4.5）

1. 停 Pidot 和 workspace-mcp。
2. 复制整个数据库目录（`pidot.sqlite` 及同级的 `google/`、`external-mcp/`、`bot-workspaces/`、`skills/`），保留权限（`google/`、`external-mcp/` 是 0700）。
3. 服务器上 `uv tool install workspace-mcp==2.2.1`。
4. 按 §2 建环境文件（客户端 ID 与 Pidot 一致；签名密钥可新生成）；端口不是 8000 时在 Pidot 的 `my-app/.env` 设 `PIDOT_WORKSPACE_MCP_URL`。
5. 按 §4 启动 workspace-mcp，再启动 Pidot。
6. 设置页「连接 Google」：账号显示已连接；「workspace-mcp」显示正在运行（2.2.1）；「连接」显示「已保存，需重新检查」，点「检查连接」后变为「已连接 · 41 个工具」。重启后必须先检查才能用，这是设计行为。不需要在服务器上另开浏览器登录 workspace-mcp。

## 8. 行为约定（给使用者和 R3-06）

- Chief 用 `mcp_manage` 的 `add`，`config` 只传 `{ "template": "google-workspace" }`，服务端展开成 `credentialSource: 'google'` 的连接（id `google-workspace`）。配置里没有地址和令牌，不接受 `url`、`credentialRef`、bearer；全实例只允许一个这样的连接。
- 每个请求现取 `google.accessToken({ services: ['gmail','drive','docs','sheets'] })`。401 只会在工具执行前出现（`RequireAuthMiddleware`），所以只在这时 `rejectToken` 并换新令牌重发一次；第二次 401 记 `MCP_GOOGLE_TOKEN_REJECTED`（确定未执行）。超时、断连、响应超限记 unknown，不重发。
- Google 未连接、未授予四项服务、刷新失败：请求发出前就失败（`MCP_GOOGLE_NOT_CONNECTED` / `MCP_GOOGLE_TOKEN_UNAVAILABLE`），记为确定失败，不是 unknown。
- workspace-mcp 校验令牌时连不上 Google 也返回 401，从外面分不出是令牌坏了还是 Google 不通；错误文案两种都说明。
- 127.0.0.1 上任何持有有效 Google 令牌的本机进程都能调用它（不核对令牌属于哪个客户端），所以只能绑本机地址。
- 真实 Google 账号的登录、发信、改文件未验证，由用户手测。
