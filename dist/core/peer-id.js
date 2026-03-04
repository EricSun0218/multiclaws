"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.derivePeerId = derivePeerId;
exports.loadOrCreateIdentity = loadOrCreateIdentity;
exports.signPayload = signPayload;
exports.verifyPayload = verifyPayload;
exports.buildHandshakePayload = buildHandshakePayload;
exports.randomNonce = randomNonce;
const node_crypto_1 = __importDefault(require("node:crypto"));
const promises_1 = __importDefault(require("node:fs/promises"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const version_1 = require("../protocol/version");
const DEFAULT_STATE_RELATIVE = ".openclaw/multiclaws";
function resolveDefaultStateDir() {
    return node_path_1.default.join(node_os_1.default.homedir(), DEFAULT_STATE_RELATIVE);
}
function derivePeerId(publicKeyPem) {
    const hash = node_crypto_1.default.createHash("sha256").update(publicKeyPem).digest("hex");
    return `oc_${hash.slice(0, 24)}`;
}
function atomicWriteJson(filePath, value) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    return promises_1.default
        .writeFile(tempPath, JSON.stringify(value, null, 2), "utf8")
        .then(() => promises_1.default.rename(tempPath, filePath));
}
async function readStoredIdentity(filePath) {
    try {
        const text = await promises_1.default.readFile(filePath, "utf8");
        const parsed = JSON.parse(text);
        if (parsed.version !== 1 ||
            typeof parsed.peerId !== "string" ||
            typeof parsed.displayName !== "string" ||
            typeof parsed.publicKey !== "string" ||
            typeof parsed.privateKey !== "string") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
async function loadOrCreateIdentity(params) {
    const stateDir = params?.stateDir ?? resolveDefaultStateDir();
    await promises_1.default.mkdir(stateDir, { recursive: true });
    const filePath = node_path_1.default.join(stateDir, "identity.json");
    const existing = await readStoredIdentity(filePath);
    if (existing) {
        return {
            identity: {
                peerId: existing.peerId,
                displayName: existing.displayName,
                networkHint: params?.networkHint,
                publicKey: existing.publicKey,
                gatewayVersion: params?.gatewayVersion ?? "unknown",
                multiclawsProtocol: version_1.MULTICLAWS_PROTOCOL_VERSION,
            },
            privateKeyPem: existing.privateKey,
        };
    }
    const keyPair = node_crypto_1.default.generateKeyPairSync("ed25519", {
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const displayName = params?.displayName?.trim() || node_os_1.default.hostname();
    const peerId = derivePeerId(keyPair.publicKey);
    const stored = {
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
            multiclawsProtocol: version_1.MULTICLAWS_PROTOCOL_VERSION,
        },
        privateKeyPem: keyPair.privateKey,
    };
}
function signPayload(privateKeyPem, payload) {
    const signature = node_crypto_1.default.sign(null, Buffer.from(payload), privateKeyPem);
    return signature.toString("base64");
}
function verifyPayload(publicKeyPem, payload, signatureBase64) {
    try {
        return node_crypto_1.default.verify(null, Buffer.from(payload), publicKeyPem, Buffer.from(signatureBase64, "base64"));
    }
    catch {
        return false;
    }
}
function buildHandshakePayload(params) {
    return `${params.peerId}|${params.nonce}|${params.ackNonce ?? ""}|${params.tsMs}`;
}
function randomNonce(size = 16) {
    return node_crypto_1.default.randomBytes(size).toString("hex");
}
