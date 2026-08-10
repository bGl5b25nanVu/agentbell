<div align="center">

<img src="assets/agentbell-icon-512.png" width="120" alt="AgentBell">

# AgentBell

**面向 Claude Code、Codex 和自定义 Agent 工作流的移动审批与提醒。**

把需要你判断的自动化事项收进一个 Inbox：在 iPhone 上查看可信上下文、做出有界选择，并看清批准之后实际发生了什么——无需把终端搬到手机。

[官网](https://agentbell.app) · [下载](https://agentbell.app/download) · [安装文档](docs/install.md) · [CLI 参考](docs/cli.md) · [支持](mailto:hi@agentbell.app)

</div>

---

## 这是什么？

AgentBell 是 Mac 上运行的 Agent 的**移动伴侣**。你的普通 `claude`（或 Codex）会话照常运行；AgentBell Hook 把有界状态、完成通知、`PermissionRequest` 和结构化选择题发送到你的 iPhone。你在手机上批准、拒绝或选择候选项，答案再返回会话。

```text
ordinary claude + hooks ──HTTPS──> AgentBell Worker ──APNs──> 你的 iPhone
          ^                                                         │
          └──────────── 允许 / 拒绝 / 结构化回答 ────────────────────┘
```

### 它能做什么

- **通知** —— 会话开始/结束、重要状态、待审批提醒
- **远程审批** —— 在手机上查看完整命令并批准或拒绝
- **结构化选择** —— Agent 提出有界问题时，在手机上选择候选项
- **Live Activity** —— 在锁屏/灵动岛看到待审批事项
- **Web Inbox** —— 在任意浏览器查看提醒：[app.agentbell.app](https://app.agentbell.app)

### 它不能做什么

- 不能远程启动或接管会话、镜像终端、注入提示词
- 不上传完整 transcript 或源文件
- 超时、离线或故障时不会自动放行——审批始终回退到 Mac 原生提示

## 快速开始

1. 在 Mac 上安装 AgentBell Hook 与 Observer：

   ```bash
   bash <(curl -fsSL https://agentbell.app/install.sh)
   ```

2. 在 iPhone 打开 AgentBell 并允许通知。
3. 在 App 中进入 **设置 → 配对新 Mac**，扫描终端显示的二维码。
4. 照常使用 `claude` 命令——无需 wrapper。

也可以从 npm 安装 `agentbell` CLI：

```bash
npm install -g @claude-notify/connector-kit
agentbell status
agentbell doctor
```

详见 [docs/install.md](docs/install.md) 与 [docs/cli.md](docs/cli.md)。

## 下载

| 平台 | 链接 |
| --- | --- |
| iPhone / iPad | [App Store](https://apps.apple.com/app/id6790313067) |
| iPhone / iPad（公测） | [TestFlight](https://testflight.apple.com/join/GzaTe3q9) |
| Mac（菜单栏 App） | 即将推出——关注 [GitHub Releases](../../releases) |
| CLI | `npm install -g @claude-notify/connector-kit` |

完整下载矩阵：[docs/downloads.md](docs/downloads.md)

## 文档

- [安装指南](docs/install.md)
- [agentbell CLI 参考](docs/cli.md)
- [下载矩阵](docs/downloads.md)
- [隐私政策](https://agentbell.app/privacy) · [服务协议](https://agentbell.app/terms)

## 支持

发送邮件到 [hi@agentbell.app](mailto:hi@agentbell.app)，或在本仓库提交 [Issue](https://github.com/bGl5b25nanVu/agentbell/issues)、发起 [Discussion](https://github.com/bGl5b25nanVu/agentbell/discussions)。

## 许可证

[MIT](LICENSE)

## 独立产品声明

AgentBell 为独立开发的产品，与 Anthropic 或 OpenAI 不存在隶属、背书、赞助或官方合作关系。
