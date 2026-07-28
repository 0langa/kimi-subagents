---
provider: acp
topic: tool-permissions
checked_at: 2026-07-28
stability: likely-changing
refresh_after_days: 7
sources:
  - url: https://agentclientprotocol.com/protocol/v1/tool-calls
    title: ACP Tool Calls
claims:
  - Agents stream tool_call and tool_call_update session notifications.
  - Permission requests include tool-call metadata and allow or reject options selected by client.
  - Tool-call raw input and locations are useful for client policy but are not a complete security boundary.
used_by:
  - kimi-subagents-v0.1
---

## Notes

Broker selects one-shot permission options. Raw tool payloads stay in memory and are not persisted.
