<div align="center">

<img src="assets/agentbell-icon-512.png" width="120" alt="AgentBell">

# AgentBell

**Mobile approvals and alerts for Claude Code, Codex, and your own agent workflows.**

One Inbox for every automation decision that needs you. Review trusted context on your iPhone, make a bounded choice, and see what actually happened afterward — without moving your terminal to a phone.

[Website](https://agentbell.app) · [Download](https://agentbell.app/download) · [Install docs](docs/install.md) · [CLI reference](docs/cli.md) · [Support](mailto:hi@agentbell.app)

</div>

---

## What is AgentBell?

AgentBell is a **mobile companion for agents that run on your Mac**. Your ordinary `claude` (or Codex) session keeps running as usual; AgentBell hooks deliver bounded state, completion alerts, `PermissionRequest`s, and structured choices to your iPhone. You approve, deny, or pick an option on the phone, and the answer flows back to the session.

```text
ordinary claude + hooks ──HTTPS──> AgentBell Worker ──APNs──> your iPhone
          ^                                                         │
          └──────────── allow / deny / structured answer ───────────┘
```

### What it can do

- **Notifications** — session started/finished, important status, pending approvals
- **Remote approval** — review the exact command and approve or deny from your phone
- **Structured choices** — pick an option when the agent asks a bounded question
- **Live Activities** — see waiting approvals on the lock screen / Dynamic Island
- **Web Inbox** — check your alerts from any browser at [app.agentbell.app](https://app.agentbell.app)

### What it cannot do

- Start or take over a session remotely, mirror your terminal, or inject prompts
- Upload full transcripts or source files
- Auto-approve on timeout, offline, or failure — approval always falls back to your Mac's native prompt

## Quick start

1. Install the AgentBell hooks and observer on your Mac:

   ```bash
   bash <(curl -fsSL https://agentbell.app/install.sh)
   ```

2. Open AgentBell on your iPhone and allow notifications.
3. In the app, go to **Settings → Pair a new Mac**, then scan the QR code shown in your terminal.
4. Keep using `claude` exactly as before — no wrapper required.

Alternatively, install the `agentbell` CLI from npm:

```bash
npm install -g @claude-notify/connector-kit
agentbell status
agentbell doctor
```

See [docs/install.md](docs/install.md) and [docs/cli.md](docs/cli.md) for details.

## Downloads

| Platform | Link |
| --- | --- |
| iPhone / iPad | [App Store](https://apps.apple.com/app/id6790313067) |
| iPhone / iPad (beta) | [TestFlight](https://testflight.apple.com/join/GzaTe3q9) |
| Mac (menu-bar app) | Coming soon — watch [GitHub Releases](../../releases) |
| CLI | `npm install -g @claude-notify/connector-kit` |

Full matrix: [docs/downloads.md](docs/downloads.md)

## Documentation

- [Installation guide](docs/install.md)
- [agentbell CLI reference](docs/cli.md)
- [Downloads matrix](docs/downloads.md)
- [Privacy policy](https://agentbell.app/privacy) · [Terms of service](https://agentbell.app/terms)

## Support

Email [hi@agentbell.app](mailto:hi@agentbell.app), open an [issue](https://github.com/bGl5b25nanVu/agentbell/issues), or start a [discussion](https://github.com/bGl5b25nanVu/agentbell/discussions).

## License

[MIT](LICENSE)

## Independent product

AgentBell is independently developed and is not affiliated with, endorsed by, sponsored by, or officially connected with Anthropic or OpenAI.
