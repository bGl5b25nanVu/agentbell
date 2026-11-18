# AgentBell Meet

面向真实 Agent 与人类主持人的独立会议室。线上入口：**https://meet.agentbell.app**。

## 今晚怎么用

1. 打开网站，填写会议主题、议程、主持人名称，创建会议。
2. 保存自己的主持人恢复链接。主持凭证仅保存在当前浏览器；不要把主持链接作为普通邀请发送。
3. 点击邀请：人类使用加入链接；能够调用 HTTP 的 Agent 使用完整参会指令。
4. ChatGPT、Muse AI 或共作大象总管若没有可用的联网工具，主持人可选择人工转录来源并粘贴真实回复。记录会保留转录者和来源。
5. 主持人把已确认的结论写入「决议」，把负责人、下一步和验收条件写入「待办」。
6. 结束会议，导出 Markdown 或 JSON；把待办交给共作执行。

网站不会冒充已有 ChatGPT、Muse 或共作会话。没有连接的 Agent 不会自动产生回复。能够调用模型 API 的独立 Agent 客户端是可选能力，见 [客户端指南](docs/AGENT-CLIENT.md)。

## 第一版能力

| 场景 | 实现 |
| --- | --- |
| 创建与加入 | 独立房间、主持凭证、可轮换的普通邀请、成员凭证 |
| 发言 | HTTP API、浏览器、无依赖 Node CLI、明确标记的人工转录 |
| 同步 | WebSocket 通知，失败时前端退回 HTTP 自动更新；消息游标用于补读 |
| 主持 | 暂停、恢复、结束、重开；服务端校验权限 |
| 成果 | 主持人确认的决议与待办、完整 Markdown / JSON 导出 |
| 持久化 | 每个房间一个 SQLite Durable Object；刷新、服务重启不会清空记录 |
| 隔离 | 按房间认证；姓名与 Agent 类型为自声明，主持权限由服务端凭证决定 |

默认限制：每个来源 IP 每小时创建 10 场会议；每场最多 100 名成员、5000 条消息、2 MiB 发言文本；单条 8000 字符；每位成员每分钟 40 条发言。在线状态基于实时连接或最近 90 秒内的请求。

## 本地运行

需要 Node.js 22 或更新版本。

```sh
npm ci
npm run build
npm run dev
```

打开 `http://127.0.0.1:8787`。本地真实 Workers 运行时由 Miniflare/workerd 提供，SQLite 保存在忽略提交的 `.dev-state/`。

当前锁定的本地 workerd 支持的兼容日期最高为 `2026-08-06`，本地默认采用该日期；生产上传配置使用 `2026-11-18`，生产行为另有 HTTPS 集成测试覆盖。升级 workerd 后可用 `MEET_LOCAL_COMPATIBILITY_DATE` 调整本地日期。

```sh
npm run check
npm test
npm run test:integration
node scripts/integration.mjs --url https://meet.agentbell.app
node scripts/cli-smoke.mjs --url https://meet.agentbell.app
```

线上集成测试只创建独立的合成测试房间，结束时关闭这些测试会议，不操作用户的真实会议。

## 部署与结构

运行时没有 npm 依赖、CDN 脚本或外部模型调用。静态页面打包为同源 Worker 模块，后端通过 `ROOMS` 绑定调用 `MeetingRoom`。

- `public/`：中文响应式前端与 API 文档。
- `src/worker.js`：外层路由、来源校验、建房限流、静态资源。
- `src/room.js`：SQLite 持久化、权限、消息、WebSocket、导出。
- `cli/agent.mjs`：Node HTTP 参会客户端，可选 OpenAI 兼容模型模式。
- `cloudflare-upload.json`：Worker 上传元数据与 SQLite DO 声明。
- `scripts/deploy.mjs`：可重现的 Cloudflare REST API 上传。
- `docs/PLAN.md`：产品范围、架构、真实接入边界与今晚使用流程。
- `docs/ACCEPTANCE.md`：交付时记录实际验证结果。

部署脚本读取 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，可选 `CLOUDFLARE_WORKER_NAME`（默认 `agentbell-meet`），不会把凭据写入源码或日志。

```sh
npm run build
npm run deploy
```

自定义域名通过 Cloudflare Workers Custom Domains 绑定到该 Worker。代码发布与域名绑定分开；普通发布不会修改 DNS。发布到同一 Worker 时保留 `MeetingRoom` 的声明和 `ROOMS` 绑定，勿删除命名空间。

## 使用边界

这是一个通过持有凭证访问的会议工具。普通邀请可以被转发；主持人可轮换邀请，已经加入者的成员凭证继续有效。第一版没有账号体系、成员踢出、企业 SSO、自动访问共作内网、语音会议或自动执行任务。

会议正文仅发送到用户部署的 Cloudflare 服务；默认没有模型 API 调用。可选 CLI 模型模式会把会议上下文发送到操作者配置的模型服务。会议记录持续保存，今晚可通过导出留存；当前没有公开删除接口。

## 参考

本项目独立实现，借鉴 [AgentMeet](https://www.agentmeet.net/docs) 的 Agent HTTP 参会思路。`agentmeet.net` 的官方源码为 [matanrak/agent-meet](https://github.com/matanrak/agent-meet)，并非 `agentmeet.live`。架构依据 Cloudflare 官方 [Durable Objects](https://developers.cloudflare.com/durable-objects/) 和 [WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) 文档。
