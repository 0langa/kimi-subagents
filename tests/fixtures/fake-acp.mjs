import * as acp from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.FAKE_ACP_MODE === "malformed") {
  process.stdout.write("{malformed-acp-frame}\n");
  process.exit(0);
}

const sessions = new Map();

// Payload shapes mirror live Kimi Code 0.29.2: the permission request carries
// only toolCallId, title and content[]; rawInput and locations are absent.
function approvalText(text) {
  return { type: "content", content: { type: "text", text: `Requesting approval to ${text}` } };
}

function payloadFor(mode) {
  switch (mode) {
    case "delete":
      return { kind: "execute", title: "Bash", content: [approvalText("Running: rm fixture.txt")] };
    case "write":
      return { kind: "edit", title: "Write", content: [approvalText("Writing fixture.txt")] };
    case "escape":
      return {
        kind: "edit",
        title: "Edit",
        content: [
          { type: "diff", path: "C:/elsewhere/secrets.env", oldText: "a", newText: "b" },
          approvalText("Editing secrets.env")
        ]
      };
    case "opaque":
      return { kind: "other", title: "MysteryTool", content: [] };
    default:
      return { kind: "execute", title: "Bash", content: [approvalText("Running: npm test")] };
  }
}

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
    if (process.env.FAKE_ACP_MODE === "deadlock") {
      // Kimi retries a refused tool indefinitely; the runner must break the loop.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await client.requestPermission({
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: `tool-deadlock-${attempt}`,
            title: "AskUserQuestion",
            kind: "other",
            content: [{ type: "content", content: { type: "text", text: "Requesting approval to Call AskUserQuestion" } }]
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }
          ]
        });
        await delay(20);
      }
      return { stopReason: "end_turn" };
    }
    if (process.env.FAKE_ACP_MODE === "network") {
      // Kimi approves FetchURL itself: the client only ever sees the notification.
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: "tool-net", title: "FetchURL", kind: "fetch", status: "in_progress" }
      });
      await delay(200);
      await client.notify(acp.methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fetched" } }
      });
      return { stopReason: "end_turn" };
    }
    const { kind, title, content } = payloadFor(process.env.FAKE_ACP_MODE ?? "execute");
    await client.notify(acp.methods.client.session.update, {
      sessionId: params.sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title, kind, status: "pending" }
    });
    const permission = await client.request(acp.methods.client.session.requestPermission, {
      sessionId: params.sessionId,
      toolCall: { toolCallId: "tool-1", title, content },
      options: [
        { optionId: "approve_once", name: "Allow once", kind: "allow_once" },
        { optionId: "approve_always", name: "Allow always", kind: "allow_always" },
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
