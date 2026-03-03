export type GatewayConfig = {
  port: number;
  token: string;
};

export type InvokeToolResult = {
  ok: boolean;
  result?: unknown;
  error?: { type?: string; message?: string };
};

/**
 * Call the local OpenClaw gateway's /tools/invoke endpoint.
 * Requires the tool to be allowed by gateway policy.
 */
export async function invokeGatewayTool(params: {
  gateway: GatewayConfig;
  tool: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs?: number;
}): Promise<unknown> {
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

    const json = (await response.json()) as InvokeToolResult;

    if (!response.ok || !json.ok) {
      const msg = json.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`invokeGatewayTool(${params.tool}) failed: ${msg}`);
    }

    return json.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Extract text content from a tool result that follows the
 * { content: [{ type: "text", text: "..." }] } shape.
 */
export function extractTextContent(result: unknown): string {
  if (result == null) return "";
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    return r.content
      .filter((c): c is { type: string; text: string } => c?.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (typeof r.text === "string") return r.text;
  return JSON.stringify(result);
}
