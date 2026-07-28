# Kimi Subagents

Windows-first Codex and Claude Code plugin that delegates suitable work to installed Kimi Code through ACP. Goal: reduce expensive host-model usage on bounded routine tasks without surrendering final review or remote control.

## Status

v0.1.1 development build. Production `0langas-plugins` marketplace is intentionally untouched. Distribution uses local `kimi-subagents-dev` catalog pinned to exact pushed Git SHA.

## Requirements

- Windows 11 tested
- Node.js 20 or newer
- Kimi Code 0.29.2 or newer on `PATH`, authenticated through managed Kimi OAuth
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
- `kimi_status`, `kimi_list`, `kimi_cancel`: compact lifecycle control; status supports up to 55-second server-side terminal wait to avoid model-driven polling cost
- `kimi_result`: redacted result, usage, retries, changed files, blocks, recovery
- `kimi_restore`: selected checkpoint paths after exact explicit confirmation

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

Kimi can broadly edit and run local development commands inside granted roots. Broker blocks known permanent deletion, destructive Git, GitHub/remote mutation, credential export, workspace escape, and undelegated commits. Execute jobs checkpoint before launch and reject dirty Git trees without explicit override.

Each ACP process receives an isolated temporary `KIMI_CODE_HOME`: managed OAuth credentials are linked read-only-by-convention, safe provider/model metadata is copied without API keys, and global Kimi MCP servers, plugins, hooks, skills, sessions, and logs are not inherited. Temporary Kimi session/log state is removed when job ends. Enabled project-local `.kimi-code/mcp.json` servers cause delegation refusal because MCP parameters bypass ACP tool approval. Non-empty config API keys are unsupported in v0.1 isolation.

This is not a formal sandbox. Same-user Windows commands may evade pattern controls through novel or obfuscated execution. Main Codex/Claude agent must inspect diff/commit range, rerun checks, and label output accepted, repaired, or rejected. See [SECURITY.md](SECURITY.md) and [architecture](docs/architecture.md).

Kimi ACP `/goal` is omitted: live Kimi Code 0.29.2 returned `Unknown ACP command: /goal`.

## Development

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run security:scan
```

Provider manifests come from `forge.yaml`. Run Forge compile and sync checks after surface changes. No release tag exists for v0.1.

## License

MIT
