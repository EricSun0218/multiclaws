"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeFrame = encodeFrame;
exports.decodeFrame = decodeFrame;
const zod_1 = require("zod");
const peerIdentitySchema = zod_1.z.object({
    peerId: zod_1.z.string().min(1),
    displayName: zod_1.z.string().min(1),
    networkHint: zod_1.z.string().optional(),
    publicKey: zod_1.z.string().min(1),
    gatewayVersion: zod_1.z.string().min(1),
    multiclawsProtocol: zod_1.z.string().min(1),
});
const multiclawsFrameSchema = zod_1.z.discriminatedUnion("type", [
    zod_1.z.object({
        type: zod_1.z.literal("handshake"),
        peer: peerIdentitySchema,
        nonce: zod_1.z.string().min(1),
        tsMs: zod_1.z.number().finite(),
        signature: zod_1.z.string().min(1),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("handshake_ack"),
        peer: peerIdentitySchema,
        nonce: zod_1.z.string().min(1),
        ackNonce: zod_1.z.string().min(1),
        tsMs: zod_1.z.number().finite(),
        signature: zod_1.z.string().min(1),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("request"),
        id: zod_1.z.string().min(1),
        method: zod_1.z.string().min(1),
        params: zod_1.z.unknown(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("response"),
        id: zod_1.z.string().min(1),
        ok: zod_1.z.boolean(),
        data: zod_1.z.unknown().optional(),
        error: zod_1.z.string().optional(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("event"),
        name: zod_1.z.string().min(1),
        data: zod_1.z.unknown(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("ping"),
        tsMs: zod_1.z.number().finite(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("pong"),
        tsMs: zod_1.z.number().finite(),
    }),
    zod_1.z.object({
        type: zod_1.z.literal("error"),
        message: zod_1.z.string().min(1),
        code: zod_1.z.string().optional(),
    }),
]);
function encodeFrame(frame) {
    return JSON.stringify(frame);
}
function decodeFrame(raw) {
    try {
        const parsed = JSON.parse(raw);
        const result = multiclawsFrameSchema.safeParse(parsed);
        if (!result.success) {
            return null;
        }
        return result.data;
    }
    catch {
        return null;
    }
}
