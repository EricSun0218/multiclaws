import { describe, expect, it } from "vitest";
import { createGatewayHandlers } from "../src/gateway/handlers";

describe("gateway handlers validation", () => {
  it("rejects invalid peerId in multiclaws.peer.remove", async () => {
    const service = {
      removePeer: async () => true,
    } as any;

    const handlers = createGatewayHandlers(() => service);

    let response: { ok: boolean; errorCode?: string } | null = null;
    await handlers["multiclaws.peer.remove"]({
      params: { peerId: "   " },
      respond: (ok, _payload, error) => {
        response = { ok, errorCode: error?.code };
      },
    });

    expect(response).toEqual({ ok: false, errorCode: "invalid_params" });
  });
});
