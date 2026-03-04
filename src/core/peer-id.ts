import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MULTICLAWS_PROTOCOL_VERSION } from "../protocol/version";

export type PeerId = string;

export type PeerIdentity = {
  peerId: PeerId;
  displayName: string;
  networkHint?: string;
  publicKey: string;
  gatewayVersion: string;
  multiclawsProtocol: string;
};

type StoredIdentity = {
  version: 1;
  peerId: PeerId;
  displayName: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

const DEFAULT_STATE_RELATIVE = ".openclaw/multiclaws";

function resolveDefaultStateDir() {
  return path.join(os.homedir(), DEFAULT_STATE_RELATIVE);
}

function derivePeerId(publicKeyPem: string): PeerId {
  const hash = crypto.createHash("sha256").update(publicKeyPem).digest("hex");
  return `oc_${hash.slice(0, 24)}`;
}

function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  return fs
    .writeFile(tempPath, JSON.stringify(value, null, 2), "utf8")
    .then(() => fs.rename(tempPath, filePath));
}

async function readStoredIdentity(filePath: string): Promise<StoredIdentity | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as Partial<StoredIdentity>;
    if (
      parsed.version !== 1 ||
      typeof parsed.peerId !== "string" ||
      typeof parsed.displayName !== "string" ||
      typeof parsed.publicKey !== "string" ||
      typeof parsed.privateKey !== "string"
    ) {
      return null;
    }
    return parsed as StoredIdentity;
  } catch {
    return null;
  }
}

export async function loadOrCreateIdentity(params?: {
  stateDir?: string;
  displayName?: string;
  networkHint?: string;
  gatewayVersion?: string;
}): Promise<{ identity: PeerIdentity; privateKeyPem: string }> {
  const stateDir = params?.stateDir ?? resolveDefaultStateDir();
  await fs.mkdir(stateDir, { recursive: true });
  const filePath = path.join(stateDir, "identity.json");

  const existing = await readStoredIdentity(filePath);
  if (existing) {
    return {
      identity: {
        peerId: existing.peerId,
        displayName: existing.displayName,
        networkHint: params?.networkHint,
        publicKey: existing.publicKey,
        gatewayVersion: params?.gatewayVersion ?? "unknown",
        multiclawsProtocol: MULTICLAWS_PROTOCOL_VERSION,
      },
      privateKeyPem: existing.privateKey,
    };
  }

  const keyPair = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const displayName = params?.displayName?.trim() || os.hostname();
  const peerId = derivePeerId(keyPair.publicKey);
  const stored: StoredIdentity = {
    version: 1,
    peerId,
    displayName,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    createdAtMs: Date.now(),
  };
  await atomicWriteJson(filePath, stored);

  return {
    identity: {
      peerId,
      displayName,
      networkHint: params?.networkHint,
      publicKey: keyPair.publicKey,
      gatewayVersion: params?.gatewayVersion ?? "unknown",
      multiclawsProtocol: MULTICLAWS_PROTOCOL_VERSION,
    },
    privateKeyPem: keyPair.privateKey,
  };
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const signature = crypto.sign(null, Buffer.from(payload), privateKeyPem);
  return signature.toString("base64");
}

export function verifyPayload(publicKeyPem: string, payload: string, signatureBase64: string): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(payload),
      publicKeyPem,
      Buffer.from(signatureBase64, "base64"),
    );
  } catch {
    return false;
  }
}

export function buildHandshakePayload(params: {
  peerId: string;
  nonce: string;
  ackNonce?: string;
  tsMs: number;
}): string {
  return `${params.peerId}|${params.nonce}|${params.ackNonce ?? ""}|${params.tsMs}`;
}

export function randomNonce(size = 16): string {
  return crypto.randomBytes(size).toString("hex");
}
