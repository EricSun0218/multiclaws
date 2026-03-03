import { describe, expect, it, vi } from "vitest";
import { ApprovalRouteStore, routeFromInbound, sendApprovalPrompt } from "../src/messaging/channel-prompt";
import type { OpenClawPluginApi } from "../src/types/openclaw";

function createRuntimeMock() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const make = (fn: string) =>
    vi.fn(async (...args: unknown[]) => {
      calls.push({ fn, args });
      return { ok: true };
    });
  const runtime = {
    channel: {
      telegram: { sendMessageTelegram: make("telegram") },
      whatsapp: { sendMessageWhatsApp: make("whatsapp") },
      signal: { sendMessageSignal: make("signal") },
      imessage: { sendMessageIMessage: make("imessage") },
      line: { sendMessageLine: make("line") },
      slack: { sendMessageSlack: make("slack") },
      discord: { sendMessageDiscord: make("discord") },
    },
  } as NonNullable<OpenClawPluginApi["runtime"]>;
  return { runtime, calls };
}

describe("approval channel prompt", () => {
  it("extracts route from inbound hook event", () => {
    const route = routeFromInbound(
      {
        from: "u_123",
        content: "hello",
        metadata: {
          threadId: 42,
          to: "chat_abc",
        },
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: "chat_abc",
      },
    );

    expect(route).toMatchObject({
      channelId: "telegram",
      accountId: "default",
      conversationId: "chat_abc",
      threadId: 42,
    });
  });

  it("sends prompt via channel-specific runtime sender", async () => {
    const { runtime, calls } = createRuntimeMock();
    await sendApprovalPrompt({
      runtime,
      route: {
        channelId: "telegram",
        accountId: "acc",
        conversationId: "chat_1",
        threadId: "99",
        lastSeenAtMs: Date.now(),
      },
      text: "approval needed",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      fn: "telegram",
      args: ["chat_1", "approval needed", { accountId: "acc", messageThreadId: 99 }],
    });
  });

  it("stores latest route snapshot", () => {
    const store = new ApprovalRouteStore();
    expect(store.getLatest()).toBeNull();
    store.update({
      channelId: "signal",
      conversationId: "+123",
      accountId: "main",
      lastSeenAtMs: Date.now(),
    });
    expect(store.getLatest()?.channelId).toBe("signal");
  });
});
