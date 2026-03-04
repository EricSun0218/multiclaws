import { z } from "zod";
import type { MulticlawsFrame } from "./types";

const peerIdentitySchema = z.object({
  peerId: z.string().min(1),
  displayName: z.string().min(1),
  networkHint: z.string().optional(),
  publicKey: z.string().min(1),
  gatewayVersion: z.string().min(1),
  multiclawsProtocol: z.string().min(1),
});

const multiclawsFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("handshake"),
    peer: peerIdentitySchema,
    nonce: z.string().min(1),
    tsMs: z.number().finite(),
    signature: z.string().min(1),
  }),
  z.object({
    type: z.literal("handshake_ack"),
    peer: peerIdentitySchema,
    nonce: z.string().min(1),
    ackNonce: z.string().min(1),
    tsMs: z.number().finite(),
    signature: z.string().min(1),
  }),
  z.object({
    type: z.literal("request"),
    id: z.string().min(1),
    method: z.string().min(1),
    params: z.unknown(),
  }),
  z.object({
    type: z.literal("response"),
    id: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("event"),
    name: z.string().min(1),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal("ping"),
    tsMs: z.number().finite(),
  }),
  z.object({
    type: z.literal("pong"),
    tsMs: z.number().finite(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string().min(1),
    code: z.string().optional(),
  }),
]);

export function encodeFrame(frame: MulticlawsFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(raw: string): MulticlawsFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = multiclawsFrameSchema.safeParse(parsed);
    if (!result.success) {
      return null;
    }
    return result.data as MulticlawsFrame;
  } catch {
    return null;
  }
}
