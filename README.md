# Kimi Subagents

Windows-first Codex and Claude Code plugin that delegates suitable work to installed Kimi Code through ACP. Goal: reduce expensive host-model usage on bounded routine tasks without surrendering final review or remote control.

## Status

v0.1.1 development build. Production `0langas-plugins` marketplace is intentionally untouched. Distribution uses local `kimi-subagents-dev` catalog pinned to exact pushed Git SHA.

## Requirements

- Windows 11 tested
- Node.js 20 or newer
- Kimi Code 0.29.2 or newer on `PATH`, authenticated through managed Kimi OAuth
- Git Bash (shipped with Git for Windows); jobs are refused when bash is unavailable because the shell guard cannot be installed
- Codex or Claude Code with plugin support

No Python, WSL, Docker, or runtime package install. Repository commits bundled `dist/server.mjs`; installed runtime starts with `node`.

## Modes

Mode belongs to current host conversation and can change anytime:

| Mode | Behavior |
| --- | --- |
| `off` | inactive; default before activation |
| `manual` | launch only direct task-specific Kimi requests; default on invocation |
| `ask` | propose one declared batch and wait for approval |
| `auto` | delegate suitable routine work without approval; maximum three jobs/user request |

Examples:

```text
Use kimi-subagents in ask mode until I tell you otherwise.
Use kimi-subagents auto.
Switch Kimi to manual.
Disable kimi-subagents.
```

Codex can invoke `$kimi-subagents`. Claude Code exposes `/kimi-subagents:kimi-subagents`, `/kimi-subagents:kimi-mode`, and `/kimi-subagents:kimi-status`.

## MCP tools

- `kimi_preflight`: versions, authentication/session creation, ACP capabilities
- `kimi_start`: asynchronous `analyze`, native `plan`, or `execute` job
- `kimi_followup`: continue a finished job with a new instruction; inherits workspace, roots and flags and carries a compact summary of the parent job
- `kimi_status`, `kimi_list`, `kimi_cancel`: compact lifecycle control; status supports up to 55-second server-side terminal wait to avoid model-driven polling cost
- `kimi_result`: redacted result, usage, retries, changed files, capped unified diff, blocks, full shell command log, recovery
- `kimi_restore`: selected checkpoint paths after exact explicit confirmation

`kimi_start` gates risky operations behind explicit flags: `allowCommit` (local commit), `allowDelete` (file deletion inside granted roots), `allowDirty` (start from a dirty tree).

Maximum two concurrent jobs, one execute writer/workspace, two nested Kimi agents/job. No default timeout. One transient failure retries once.

## Development install

Build and verify source:

```powershell
npm ci
npm run validate
```

After commit is pushed, generate local exact-SHA catalog:

```powershell
npm run dev:catalog
```

Generator writes `%LOCALAPPDATA%\kimi-subagents\dev-marketplace`. Add and install:

```powershell
$catalog = Join-Path $env:LOCALAPPDATA 'kimi-subagents\dev-marketplace'
codex plugin marketplace add $catalog
codex plugin add kimi-subagents@kimi-subagents-dev
claude plugin marketplace add $catalog --scope user
claude plugin install kimi-subagents@kimi-subagents-dev --scope user
```

Restart host after installation. Marketplace installs are cached; regenerate catalog only from pushed SHA and reinstall/update when testing a new commit.

## Safety

Enforcement runs in two layers, because Kimi's ACP permission request carries only a tool name and a description truncated at 50 characters — never the full command.

1. **ACP permission broker.** Parses the approval payload (`Running:`, `Writing`, `Editing`, `Call`, diff entries), resolves relative paths against the workspace, denies destructive and out-of-root operations, and **denies anything it cannot parse**. Approvals are one-shot; `allow_always` is never selected.
2. **Shell guard.** `assets/shell-guard.sh` is sourced through `BASH_ENV` into every Bash process the job starts — including nested and subagent shells — and inspects each command with its full text via a `DEBUG` trap, exiting 126 on denial. The bootstrap is syntax-checked before the job starts; a job runs guarded or not at all. Every decision is logged and returned as `shellCommands`.

Denied by default: permanent deletion, destructive Git, remote Git and GitHub CLI usage, package publication, global tool configuration changes, credential file or environment access, alternate interpreters (`powershell`, `cmd`, `wsl`), network uploads, directory changes and writes outside the granted roots, local commits. `allowCommit` and `allowDelete` open exactly one class each.

Each ACP process receives an isolated temporary `KIMI_CODE_HOME` **and relocated `HOME`/`USERPROFILE`**: managed OAuth credentials are linked, safe provider/model metadata is copied without API keys, and host Kimi MCP servers, plugins, hooks, sessions, logs, host skill directories (`~/.agents/skills` and provider skill directories) and host credential files (`~/.npmrc`, `~/.ssh`) are not visible. Only Git identity is carried forward. A delegated job sees Kimi's three built-in skills and nothing else, on any machine. Enabled project-local `.kimi-code/mcp.json` servers cause refusal. Non-empty config API keys are unsupported.

This is not a sandbox. `FetchURL`, `WebSearch`, `Agent` and `AgentSwarm` are auto-approved by Kimi itself and never reach the broker, so outbound reads and subagent spawning cannot be blocked — only the shell commands those subagents run are guarded. Same-user execution may still evade pattern controls through obfuscation. The main Codex/Claude agent must inspect the diff or commit range, rerun checks, and label output accepted, repaired or rejected. See [SECURITY.md](SECURITY.md) and [architecture](docs/architecture.md).

Kimi ACP `/goal` is omitted: live Kimi Code 0.29.2 returned `Unknown ACP command: /goal`.

## Development

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run security:scan
```

`npm test` is deterministic and never starts Kimi; its ACP fixtures are captured from live Kimi payloads. `npm run test:live` drives the installed Kimi binary through real jobs and asserts guard enforcement, skill isolation and MCP isolation. Run it after any change to the runtime, the guard or the isolation logic.

Provider manifests come from `forge.yaml`. Run Forge compile and sync checks after surface changes. No release tag exists for v0.1.

## License

MIT
