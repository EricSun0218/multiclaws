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
  if (typeof r === "string") return r;
  return JSON.stringify(result);
}

export type LocalMemorySearchResult = {
  path: string;
  snippet: string;
  score: number;
};

/**
 * Parse the text output of the `memory_search` tool into structured results.
 *
 * memory_search returns text like:
 *   Source: memory/2024-01-01.md#12
 *   Content: some snippet...
 *
 *   Source: MEMORY.md#5
 *   Content: another snippet...
 */
export function parseMemorySearchResult(result: unknown): LocalMemorySearchResult[] {
  const text = extractTextContent(result);
  if (!text) return [];

  const results: LocalMemorySearchResult[] = [];

  // Try to parse structured "Source: ... Content: ..." blocks
  const blocks = text.split(/\n\s*\n/);
  for (const block of blocks) {
    const sourceMatch = block.match(/Source:\s*(.+)/i);
    const contentMatch = block.match(/Content:\s*([\s\S]+)/i);
    if (sourceMatch && contentMatch) {
      results.push({
        path: sourceMatch[1].trim(),
        snippet: contentMatch[1].trim().slice(0, 500),
        score: 1,
      });
      continue;
    }
    // Fallback: treat each non-empty block as a standalone snippet
    const trimmed = block.trim();
    if (trimmed && results.length === 0) {
      results.push({ path: "memory", snippet: trimmed.slice(0, 500), score: 1 });
    }
  }

  return results;
}

/**
 * Extract a human-readable output string from a sessions_spawn (run mode) result.
 * The result may be a content array, a plain string, or an object with a text field.
 */
export function parseSpawnTaskResult(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;

  const r = result as Record<string, unknown>;

  // sessions_spawn run mode returns { output?: string } or content array
  if (typeof r.output === "string") return r.output;
  if (typeof r.result === "string") return r.result;

  const text = extractTextContent(result);
  if (text) return text;

  return JSON.stringify(result);
}
