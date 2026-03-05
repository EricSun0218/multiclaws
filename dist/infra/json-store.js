"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureJsonFile = ensureJsonFile;
exports.readJsonWithFallback = readJsonWithFallback;
exports.writeJsonAtomically = writeJsonAtomically;
exports.withJsonLock = withJsonLock;
const promises_1 = __importDefault(require("node:fs/promises"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_path_1 = __importDefault(require("node:path"));
const proper_lockfile_1 = __importDefault(require("proper-lockfile"));
const LOCK_OPTIONS = {
    retries: {
        retries: 10,
        factor: 1.5,
        minTimeout: 50,
        maxTimeout: 1_000,
        randomize: true,
    },
    stale: 10_000,
};
async function ensureJsonFile(filePath, fallback) {
    await promises_1.default.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    try {
        await promises_1.default.access(filePath);
    }
    catch {
        await writeJsonAtomically(filePath, fallback);
    }
}
async function readJsonWithFallback(filePath, fallback) {
    try {
        const content = await promises_1.default.readFile(filePath, "utf8");
        return JSON.parse(content);
    }
    catch {
        return fallback;
    }
}
async function writeJsonAtomically(filePath, value) {
    await promises_1.default.mkdir(node_path_1.default.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.${node_crypto_1.default.randomUUID()}.tmp`;
    await promises_1.default.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await promises_1.default.rename(tmp, filePath);
}
async function withJsonLock(filePath, fallback, fn) {
    await ensureJsonFile(filePath, fallback);
    const release = await proper_lockfile_1.default.lock(filePath, LOCK_OPTIONS);
    try {
        return await fn();
    }
    finally {
        await release();
    }
}
