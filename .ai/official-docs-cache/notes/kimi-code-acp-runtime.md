---
provider: kimi-code
topic: acp-runtime
checked_at: 2026-07-28
stability: likely-changing
refresh_after_days: 7
sources:
  - url: https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp.html
    title: kimi acp Subcommand
claims:
  - kimi acp uses JSON-RPC over stdin/stdout and writes diagnostics to stderr.
  - ACP initialization advertises supported capabilities; session/new drives Kimi sessions.
  - Shell commands execute locally because ACP terminal reverse RPC is not connected.
  - ACP file reads and writes can route through client only when client advertises fs capabilities.
used_by:
  - kimi-subagents-v0.1
---

## Notes

Runtime sends no forwarded MCP servers. Live Kimi 0.29.2 additionally verified initialize and session/new. User/project Kimi MCP configuration is separate from ACP-forwarded servers, so runtime isolation is documented in the companion `kimi-code-config-isolation` note. `/goal` was not advertised and returned `Unknown ACP command: /goal`.
