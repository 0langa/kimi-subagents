---
provider: kimi-code
topic: config-isolation
checked_at: 2026-07-28
stability: likely-changing
refresh_after_days: 7
sources:
  - url: https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files
    title: Configuration files
  - url: https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html
    title: Model Context Protocol
  - url: https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html
    title: Environment variables
claims:
  - KIMI_CODE_HOME relocates Kimi configuration, session, log, credential, and related data.
  - User MCP servers live under KIMI_CODE_HOME/mcp.json; project MCP servers live at .kimi-code/mcp.json.
  - MCP tool parameter values are not part of static permission-pattern matching.
  - config.toml supports a global tool allowlist/denylist distinct from permission rules.
used_by:
  - kimi-subagents-v0.1-runtime-isolation
---

## Notes

Live testing found user-level Scalpel MCP remained available even when ACP `session/new` supplied an empty `mcpServers` array. v0.1 therefore launches each job with isolated `KIMI_CODE_HOME`, links managed OAuth credentials, filters provider/model config, omits user MCP/plugins/hooks, and refuses enabled project-local Kimi MCP servers.
