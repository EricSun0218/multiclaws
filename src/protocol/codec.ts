import type { MulticlawsFrame } from "./types";

export function encodeFrame(frame: MulticlawsFrame): string {
  return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeFrame(raw: string): MulticlawsFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }
    switch (parsed.type) {
      case "handshake":
        if (
          !isRecord(parsed.peer) ||
          typeof parsed.nonce !== "string" ||
          typeof parsed.tsMs !== "number" ||
          typeof parsed.signature !== "string"
        ) return null;
        break;
      case "handshake_ack":
        if (
          !isRecord(parsed.peer) ||
          typeof parsed.nonce !== "string" ||
          typeof parsed.ackNonce !== "string" ||
          typeof parsed.tsMs !== "number" ||
          typeof parsed.signature !== "string"
        ) return null;
        break;
      case "request":
        if (
          typeof parsed.id !== "string" ||
          typeof parsed.method !== "string"
        ) return null;
        break;
      case "response":
        if (
          typeof parsed.id !== "string" ||
          typeof parsed.ok !== "boolean"
        ) return null;
        break;
      case "event":
        if (typeof parsed.name !== "string") return null;
        break;
      case "ping":
      case "pong":
        if (typeof parsed.tsMs !== "number") return null;
        break;
      case "error":
        if (typeof parsed.message !== "string") return null;
        break;
      default:
        return null;
    }
    return parsed as MulticlawsFrame;
  } catch {
    return null;
  }
}
