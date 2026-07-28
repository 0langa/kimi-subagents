import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

const sessions = new Map();

const implementation = {
  initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { configOptions: {} } } };
  },
  newSession() {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cancelled: false });
    return { sessionId, configOptions: [] };
  },
  setConfig() { return { configOptions: [] }; },
  async prompt(params, client) {
    const session = sessions.get(params.sessionId);
    if (process.env.FAKE_ACP_MODE === "delay") {
      while (!session.cancelled) await delay(25);
      return { stopReason: "cancelled" };
    }
    const mode = process.env.FAKE_ACP_MODE ?? "safe";
    const kind = mode === "delete" ? "delete" : mode === "execute" ? "execute" : "read";
    const title = mode === "delete" ? "Remove-Item fixture.txt" : mode === "execute" ? "Run npm test" : "Read fixture";
    const toolCall = {
      toolCallId: "tool-1",
      title,
      kind,
      status: "pending",
      locations: [{ path: `${process.cwd()}\\fixture.txt` }],
      rawInput: mode === "delete" ? { command: "Remove-Item", path: `${process.cwd()}\\fixture.txt` } : { command: "npm test" }
    };
    await client.notify(acp.methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: "tool_call", ...toolCall } });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" }
      ]
    });
    const choice = permission.outcome.outcome === "selected" ? permission.outcome.optionId : "cancelled";
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `permission:${choice}` } }
    });
    return { stopReason: "end_turn", usage: { totalTokens: 12, inputTokens: 8, outputTokens: 4 } };
  },
  cancel(params) {
    const session = sessions.get(params.sessionId);
    if (session) session.cancelled = true;
  }
};

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
acp.agent({ name: "fake-kimi" })
  .onRequest(acp.methods.agent.initialize, () => implementation.initialize())
  .onRequest(acp.methods.agent.session.new, () => implementation.newSession())
  .onRequest(acp.methods.agent.session.setConfigOption, () => implementation.setConfig())
  .onRequest(acp.methods.agent.session.prompt, (context) => implementation.prompt(context.params, context.client))
  .onNotification(acp.methods.agent.session.cancel, (context) => implementation.cancel(context.params))
  .connect(stream);
