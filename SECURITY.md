# Security

Kimi Subagents runs Kimi Code as same Windows user as Codex or Claude Code. v0.1 reduces known risks; it cannot provide a hard security boundary against novel or obfuscated commands.

## Trust boundary

- MCP server autostart is allowed after plugin installation. It does not start Kimi until `kimi_start` or `kimi_preflight` is called.
- Each job starts one `kimi acp` process with primary workspace and explicitly granted extra roots.
- Each process uses a temporary isolated `KIMI_CODE_HOME`. It links managed OAuth credentials, writes filtered provider/model metadata with no API key, and inherits no user-level Kimi MCP servers, plugins, hooks, skills, sessions, or logs.
- Kimi receives no forwarded host MCP servers. Jobs also refuse enabled project-local `.kimi-code/mcp.json` servers because their parameters are not visible to ACP permission approval.
- `GITHUB_TOKEN`, `GITHUB_TOKEN_ELEVATED`, `GITHUB_TOKEN_FULL`, `GH_TOKEN`, `GITLAB_TOKEN`, and `NPM_TOKEN` are removed from child environment.
- Public unauthenticated reads may run. Main agent must fetch or materialize private GitHub context locally.
- Kimi may read sensitive files inside granted roots. Do not grant roots containing data task does not require.

## Permission broker

Policy is allow-unless-blocked for execute jobs. Broker denies:

- permanent deletion and destructive Git (`clean`, `reset --hard`, stash/branch/tag deletion, aggressive GC);
- Git pushes and GitHub mutations through known `git`, `gh`, and HTTP command patterns;
- credential export commands;
- local commits unless task explicitly sets `allowCommit`;
- file locations and ordinary absolute shell paths outside granted roots;
- relative file-mutation tool paths and relative shell file writes whose containment cannot be proven;
- edits and command execution for `analyze`; file mutation for `plan`.

Same-user shell execution can bypass pattern controls through a new tool, interpreter, encoding, indirection, or obfuscation. Main agent must independently review every Kimi diff or commit and rerun relevant checks. Permanent local deletion and every GitHub mutation remain main-agent-only after user approval where required.

## Data handling

- Raw ACP transcripts, raw tool payloads, request headers, and environment values are not persisted.
- Isolated Kimi session/log data is removed at job end; global Kimi session history is not used.
- Job records contain redacted task summary, final response, progress, usage, changed paths, blocked actions, and recovery metadata.
- Known environment secret values and common token shapes are redacted before persistence.
- Runtime data lives under `%LOCALAPPDATA%\kimi-subagents` and expires after seven days.
- Public-tree security scan rejects secret-like values, private keys, and personal absolute paths.

## Recovery

Execute job checkpoint is created before Kimi starts. Git workspaces store bundle of all refs, baseline commit/status, copies of modified/untracked/non-disposable ignored files, and pre-write copies for declared tool locations. Non-Git workspaces copy non-disposable files. Dependency/build caches are excluded.

Checkpoint is refused above 1 GiB or 100,000 files. `kimi_restore` restores only selected checkpointed paths and requires exact confirmation `RESTORE <job-id>`. No automatic whole-workspace overwrite occurs.

## Authentication limitation

v0.1 safe isolation supports managed Kimi OAuth. A non-empty API key in Kimi `config.toml` is not copied or linked into temporary runtime state; preflight/job fails closed with an explicit error.

## Reporting vulnerabilities

Open a GitHub issue without secrets or exploit payloads containing real credentials. For sensitive reports, contact repository owner privately through GitHub profile channels.
