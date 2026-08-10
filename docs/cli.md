# agentbell CLI reference

The `agentbell` CLI is part of the [@claude-notify/connector-kit](https://www.npmjs.com/package/@claude-notify/connector-kit)
npm package. It manages your Mac integration, pairing, approvals, and message
inbox from the command line.

## Install

```bash
npm install -g @claude-notify/connector-kit
```

## Common commands

| Command | Description |
| --- | --- |
| `agentbell install` | Install Claude Code and/or Codex integration (`--claude`, `--codex` flags) |
| `agentbell update --check` | Check for an AgentBell update |
| `agentbell status --json` | Show pairing and connection status as JSON |
| `agentbell doctor` | Read-only health report (permissions, hooks, server capability, credentials) |
| `agentbell pair` | Start QR-based Custom Connector enrollment for approvals |
| `agentbell subscribe add <file>` | Add a message subscription |
| `agentbell notify send ...` | Send a message from a Source credential |
| `agentbell messages list` | List inbox messages for a Human session |
| `agentbell messages watch ...` | Watch for new messages |
| `agentbell logs --component observer --follow` | Follow observer logs |
| `agentbell approvals list` | List pending approval requests |
| `agentbell uninstall` | Remove AgentBell-managed user assets |

## Examples

### Send a notification from a connector

```bash
agentbell notify send --credential ./source-credential.json \
  --event-id build-42 --topic build.completed --kind build \
  --severity normal --title "Build completed" \
  --body "Build 42 is ready" --facts '[]' --links '[]'
```

### Check everything

```bash
agentbell doctor --credential ./source-credential.json
```

`status` and `doctor` output is secret-free JSON, safe for support tickets.
`notify test` always uses server-side dry-run validation and creates no message.

## Compatibility

If a Human session token is unavailable, the CLI falls back to the legacy
`~/.claude-notify/config` HMAC path so upgraded installations keep working.

## More

- Full protocol documentation: <https://agentbell.app/support>
- Contact: [hi@agentbell.app](mailto:hi@agentbell.app)
