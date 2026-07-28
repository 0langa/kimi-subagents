# Security

Kimi Subagents runs Kimi Code as the same Windows user as Codex or Claude Code. It reduces known risks and produces a complete audit trail; it is not a sandbox and cannot stop a determined adversarial agent.

## Trust boundary

- The MCP server may autostart after installation. It starts no Kimi process until `kimi_preflight` or `kimi_start` is called.
- Each job runs one `kimi acp` process scoped to the primary workspace plus explicitly granted extra roots.
- Each process gets a temporary isolated `KIMI_CODE_HOME`: managed OAuth credentials are linked, filtered provider/model metadata is written without API keys, and user-level Kimi MCP servers, plugins, hooks, sessions and logs are not inherited.
- `HOME` and `USERPROFILE` are relocated to that temporary home, so host skill directories (`~/.agents/skills`, provider skill directories) and host credential files (`~/.npmrc`, `~/.ssh`, `~/.aws`) are invisible to the delegated process. Only Git identity (`user.name`, `user.email`) is copied forward.
- Jobs refuse enabled project-local `.kimi-code/mcp.json` servers because MCP parameters are not visible to ACP approval.
- `GITHUB_TOKEN`, `GITHUB_TOKEN_ELEVATED`, `GITHUB_TOKEN_FULL`, `GH_TOKEN`, `GITLAB_TOKEN` and `NPM_TOKEN` are removed from the child environment.
- Kimi can read any file inside granted roots. Do not grant roots holding data the task does not need.

## Two enforcement layers

Kimi's ACP permission request contains only the tool name and a short approval description. It never carries `rawInput` or `locations`, and command previews are truncated by Kimi at 50 characters. A client-side broker alone therefore cannot see what a shell command actually does. Enforcement is split accordingly.

### Layer 1 — ACP permission broker (`src/policy.ts`)

Runs on every permission request Kimi sends. It parses `toolCall.content`:

- `Running: <command>` for shell tools (possibly truncated),
- `Writing <path>` / `Editing <path>` plus `diff` entries carrying absolute paths,
- `Call <tool>` for MCP tools.

It denies destructive Git, remote Git and GitHub CLI usage, credential access, alternate interpreters, deletion without `allowDelete`, commits without `allowCommit`, paths outside granted roots, every command and mutation in `analyze`/`plan` jobs, all MCP tool calls, and **any payload it cannot parse** (fail closed). Approvals are always one-shot: `allow_always` is never selected, so every call is re-evaluated.

### Layer 2 — shell guard (`assets/shell-guard.sh`)

Every job exports `BASH_ENV` pointing at a per-job bootstrap that sources the guard into every Bash process Kimi starts, including nested shells and subagent shells. A `DEBUG` trap with `set -o functrace` inspects each command with its **full text** before execution and exits 126 on denial. The bootstrap is syntax-checked with `bash -n` before the job starts; if bash or the guard asset is missing, the job is refused rather than run unguarded.

The guard denies: permanent deletion (unless `allowDelete`), destructive Git, remote Git mutation and GitHub/GitLab CLIs, package publication and registry login, global tool configuration changes, local commits (unless `allowCommit`), alternate interpreters (`powershell`, `pwsh`, `cmd`, `wsl`), credential file access, environment credential dumping, network uploads, piping downloads into interpreters, directory changes outside granted roots, and writes to absolute paths outside granted roots. Reads outside the roots are allowed but recorded.

Commands issued by nested tooling (a build script started by `npm run build`) are tracked at depth > 1: interpreter escapes, remote mutation, credential access and out-of-root writes still apply, while deletion and commit rules apply only to commands Kimi itself issues, so ordinary build scripts keep working.

Every inspected command is written to a per-job log, surfaced as `shellCommands` in the job record, and each denial also appears in `blockedActions` with `source: "shell-guard"`.

## What the design does not cover

- Kimi auto-approves several tools without asking the client at all: `Read`, `Grep`, `Glob`, `ReadMediaFile`, `WebSearch`, `FetchURL`, `Agent`, `AgentSwarm`, `Skill`, `TodoList`, task tools, `CronList` and goal tools. In particular **`FetchURL` is an outbound channel this plugin cannot intercept**, and subagent spawning cannot be blocked (nested subagent *shell* commands do pass through both layers).
- A same-user process can, in principle, defeat pattern matching with encoding, indirection or an unlisted interpreter. The guard raises cost; it is not a boundary.
- Files inside granted roots can be overwritten by allowed commands; recovery checkpoints, not prevention, cover that case.
- Reads of files outside the granted roots via the shell are permitted (recorded, not blocked) so that toolchains keep working.

The main agent remains responsible for reviewing every diff or delegated commit and rerunning relevant checks. GitHub mutation and permanent deletion outside the granted roots stay main-agent-only.

## Data handling

- Raw ACP transcripts, raw tool payloads and environment values are not persisted.
- Isolated Kimi session/log data is removed at job end; global Kimi session history is never used.
- Job records hold redacted task summary, final response, progress, usage, changed paths, blocked actions, shell command log and recovery metadata.
- Known environment secret values and common token shapes are redacted before persistence.
- Runtime data lives under `%LOCALAPPDATA%\kimi-subagents` and expires after seven days.
- The public-tree security scan rejects secret-like values, private keys and personal absolute paths.

## Recovery

An execute job checkpoints before Kimi starts. Git workspaces store a bundle of all refs, baseline commit and status, and copies of modified, untracked and non-disposable ignored files; further copies are taken before approved file mutations. Non-Git workspaces copy all non-disposable files. Dependency and build caches are excluded.

Checkpoints are refused above 1 GiB or 100,000 files. `kimi_restore` restores only the selected checkpointed paths and requires the exact confirmation `RESTORE <job-id>`. No automatic whole-workspace overwrite occurs.

## Authentication limitation

Isolation supports managed Kimi OAuth. A non-empty API key in Kimi `config.toml` is never copied into the temporary runtime; preflight and jobs fail closed with an explicit error.

## Reporting vulnerabilities

Open a GitHub issue without secrets or exploit payloads containing real credentials. For sensitive reports, contact the repository owner privately through GitHub profile channels.
