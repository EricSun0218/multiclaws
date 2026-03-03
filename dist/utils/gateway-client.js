"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invokeGatewayTool = invokeGatewayTool;
exports.extractTextContent = extractTextContent;
/**
 * Call the local OpenClaw gateway's /tools/invoke endpoint.
 * Requires the tool to be allowed by gateway policy.
 */
async function invokeGatewayTool(params) {
    const url = `http://localhost:${params.gateway.port}/tools/invoke`;
    const controller = new AbortController();
    const timer = params.timeoutMs
        ? setTimeout(() => controller.abort(), params.timeoutMs)
        : null;
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
            throw new Error(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
        }
        return json.result;
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
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
    return JSON.stringify(result);
}
