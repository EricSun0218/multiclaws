import type { PeerIdentity } from "../core/peer-id";

export type MulticlawsFrame =
  | {
      type: "handshake";
      peer: PeerIdentity;
      nonce: string;
      tsMs: number;
      signature: string;
    }
  | {
      type: "handshake_ack";
      peer: PeerIdentity;
      nonce: string;
      ackNonce: string;
      tsMs: number;
      signature: string;
    }
  | {
      type: "request";
      id: string;
      method: string;
      params: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: boolean;
      data?: unknown;
      error?: string;
    }
  | {
      type: "event";
      name: string;
      data: unknown;
    }
  | { type: "ping"; tsMs: number }
  | { type: "pong"; tsMs: number }
  | { type: "error"; message: string; code?: string };

export type OutboundMulticlawsRequest = {
  id: string;
  method: string;
  params: unknown;
  timeoutMs?: number;
};

export type InboundMulticlawsRequest = {
  peerId: string;
  id: string;
  method: string;
  params: unknown;
};

export type InboundMulticlawsRequestHandler = (request: InboundMulticlawsRequest) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}>;
