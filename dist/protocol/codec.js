"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeFrame = encodeFrame;
exports.decodeFrame = decodeFrame;
function encodeFrame(frame) {
    return JSON.stringify(frame);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeFrame(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed.type !== "string") {
            return null;
        }
        switch (parsed.type) {
            case "handshake":
                if (!isRecord(parsed.peer) ||
                    typeof parsed.nonce !== "string" ||
                    typeof parsed.tsMs !== "number" ||
                    typeof parsed.signature !== "string")
                    return null;
                break;
            case "handshake_ack":
                if (!isRecord(parsed.peer) ||
                    typeof parsed.nonce !== "string" ||
                    typeof parsed.ackNonce !== "string" ||
                    typeof parsed.tsMs !== "number" ||
                    typeof parsed.signature !== "string")
                    return null;
                break;
            case "request":
                if (typeof parsed.id !== "string" ||
                    typeof parsed.method !== "string")
                    return null;
                break;
            case "response":
                if (typeof parsed.id !== "string" ||
                    typeof parsed.ok !== "boolean")
                    return null;
                break;
            case "event":
                if (typeof parsed.name !== "string")
                    return null;
                break;
            case "ping":
            case "pong":
                if (typeof parsed.tsMs !== "number")
                    return null;
                break;
            case "error":
                if (typeof parsed.message !== "string")
                    return null;
                break;
            default:
                return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
