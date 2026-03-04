import { describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame } from "../src/protocol/codec";

describe("protocol codec", () => {
  it("decodes a valid ping frame", () => {
    const frame = { type: "ping" as const, tsMs: Date.now() };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded).toEqual(frame);
  });

  it("rejects malformed handshake frames", () => {
    const malformed = {
      type: "handshake",
      peer: {
        peerId: "oc_x",
        displayName: "x",
        publicKey: "pk",
        // gatewayVersion missing
        multiclawsProtocol: "1.0",
      },
      nonce: "n",
      tsMs: Date.now(),
      signature: "sig",
    };
    const decoded = decodeFrame(JSON.stringify(malformed));
    expect(decoded).toBeNull();
  });
});
