import { describe, expect, it } from "vitest";
import { createGatewayHandlers } from "../src/gateway/handlers";

describe("gateway handlers validation", () => {
  it("rejects invalid url in multiclaws.agent.remove", async () => {
    const service = {
      removeAgent: async () => true,
    } as any;

    const handlers = createGatewayHandlers(() => service);

    let response: { ok: boolean; errorCode?: string } | null = null;
    await handlers["multiclaws.agent.remove"]({
      params: { url: "   " },
      respond: (ok, _payload, error) => {
        response = { ok, errorCode: error?.code };
      },
    });

    expect(response).toEqual({ ok: false, errorCode: "invalid_params" });
  });
});
