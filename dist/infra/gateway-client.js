"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeGatewayTool = invokeGatewayTool;
exports.extractTextContent = extractTextContent;
exports.parseSpawnTaskResult = parseSpawnTaskResult;
const opossum_1 = __importDefault(require("opossum"));
class NonRetryableError extends Error {
}
const breakerCache = new Map();
let pRetryModulePromise = null;
let pTimeoutModulePromise = null;
async function loadPRetry() {
    if (!pRetryModulePromise) {
        pRetryModulePromise = Promise.resolve().then(() => __importStar(require("p-retry")));
    }
    return await pRetryModulePromise;
}
async function loadPTimeout() {
    if (!pTimeoutModulePromise) {
        pTimeoutModulePromise = Promise.resolve().then(() => __importStar(require("p-timeout")));
    }
    return await pTimeoutModulePromise;
}
function getBreaker(key) {
    const existing = breakerCache.get(key);
    if (existing) {
        return existing;
    }
    const breaker = new opossum_1.default((operation) => operation(), {
        timeout: 30_000,
        errorThresholdPercentage: 50,
        resetTimeout: 10_000,
        volumeThreshold: 5,
    });
    breakerCache.set(key, breaker);
    return breaker;
}
async function executeResilient(params) {
    const [pRetryModule, pTimeoutModule] = await Promise.all([loadPRetry(), loadPTimeout()]);
    const pRetry = pRetryModule.default;
    const AbortError = pRetryModule.AbortError;
    const pTimeout = pTimeoutModule.default;
    const breaker = getBreaker(params.key);
    return (await pRetry(async () => {
        try {
            const fired = breaker.fire(params.operation);
            return (await pTimeout(fired, {
                milliseconds: params.timeoutMs,
                message: `operation timeout after ${params.timeoutMs}ms`,
            }));
        }
        catch (error) {
            if (error instanceof NonRetryableError && AbortError) {
                throw new AbortError(error.message);
            }
            throw error;
        }
    }, {
        retries: 2,
        factor: 2,
        minTimeout: 150,
        maxTimeout: 1200,
        randomize: true,
    }));
}
/**
 * Call the local OpenClaw gateway's /tools/invoke endpoint.
 * Requires the tool to be allowed by gateway policy.
 */
async function invokeGatewayTool(params) {
    const url = `http://localhost:${params.gateway.port}/tools/invoke`;
    const timeoutMs = params.timeoutMs ?? 8_000;
    const key = `${params.gateway.port}:${params.tool}`;
    return await executeResilient({
        key,
        timeoutMs,
        operation: async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${params.gateway.token}`,
                    },
                    body: JSON.stringify({
                        tool: params.tool,
                        action: "json",
                        args: params.args ?? {},
                        sessionKey: params.sessionKey ?? "main",
                    }),
                    signal: controller.signal,
                });
                const json = (await response.json());
                if (!response.ok || !json.ok) {
                    const msg = json.error?.message ?? `HTTP ${response.status}`;
                    if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                        throw new NonRetryableError(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
                    }
                    throw new Error(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
                }
                return json.result;
            }
            finally {
                clearTimeout(timer);
            }
        },
    });
}
/**
 * Extract text content from a tool result that follows the
 * { content: [{ type: "text", text: "..." }] } shape.
 */
function extractTextContent(result) {
    if (result == null)
        return "";
    const r = result;
    if (Array.isArray(r.content)) {
        return r.content
            .filter((c) => c?.type === "text")
            .map((c) => c.text)
            .join("\n");
    }
    if (typeof r.text === "string")
        return r.text;
    if (typeof r === "string")
        return r;
    return JSON.stringify(result);
}
/**
 * Extract a human-readable output string from a sessions_spawn (run mode) result.
 * The result may be a content array, a plain string, or an object with a text field.
 */
function parseSpawnTaskResult(result) {
    if (result == null)
        return "";
    if (typeof result === "string")
        return result;
    const r = result;
    // sessions_spawn run mode returns { output?: string } or content array
    if (typeof r.output === "string")
        return r.output;
    if (typeof r.result === "string")
        return r.result;
    const text = extractTextContent(result);
    if (text)
        return text;
    return JSON.stringify(result);
}
