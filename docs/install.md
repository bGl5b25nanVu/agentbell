# Installation guide

AgentBell installs a set of Claude Code hooks plus a small observer that only
handles pairing and online status. Your existing `claude` workflow stays
exactly the same — no wrapper, no remote terminal.

## Requirements

- macOS (Bash 3.2 compatible) or Linux
- `curl`, `jq`, and `openssl` on your machine
- `qrencode` is optional but recommended for displaying the pairing QR code
- An iPhone or iPad with iOS 26+ for notifications and approvals

## Install the hooks

```bash
bash <(curl -fsSL https://agentbell.app/install.sh)
```

This is idempotent: re-running it updates scripts and merges configuration
without duplicating hooks or breaking existing settings.

### What it does

1. Fetches `claude-notify.sh` and installs it to `~/bin/`
2. Installs the observer and the fail-safe automatic updater
3. Writes `~/.claude-notify/config` (mode `600`) from environment variables or
   leaves a template
4. Merges Notification / Stop / StopFailure / SubagentStop / UserPromptSubmit /
   PermissionRequest hooks and the status-line pointer into
   `~/.claude/settings.json`, and installs `~/.claude/statusline.sh`

## Pair your iPhone

1. Open AgentBell on your iPhone and allow notifications.
2. In the app, go to **Settings → Pair a new Mac**.
3. Run the installer, then scan the QR code printed in your terminal.
4. The status line in Claude Code shows the pairing and online state.

## Switch to mobile mode

```bash
claude-notify-mode mobile
```

After this, `PermissionRequest` events and structured questions reach your
iPhone automatically. Approvals that time out, hit offline devices, or fail
always fall back to the native Mac prompt — nothing is auto-approved.

## Uninstall

```bash
agentbell uninstall
```

`agentbell uninstall --keep-config` preserves your identity/config so an
upgrade can be resumed without pairing again.

## Troubleshooting

- Run `agentbell doctor` for a secret-free health report.
- Check the observer log with `agentbell logs --component observer --follow`.
- Contact [hi@agentbell.app](mailto:hi@agentbell.app) for help.
