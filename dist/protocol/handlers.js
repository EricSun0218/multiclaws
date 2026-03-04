"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsProtocolHandlers = void 0;
const zod_1 = require("zod");
const memorySearchPayloadSchema = zod_1.z.object({
    query: zod_1.z.string().min(1),
    maxResults: zod_1.z.number().int().positive().max(20).optional(),
});
const delegatePayloadSchema = zod_1.z.object({
    task: zod_1.z.string().min(1),
    context: zod_1.z.string().optional(),
});
const directMessagePayloadSchema = zod_1.z.object({
    fromPeerId: zod_1.z.string().min(1),
    fromDisplayName: zod_1.z.string().min(1),
    text: zod_1.z.string().min(1),
    sentAtMs: zod_1.z.number().finite(),
});
class MulticlawsProtocolHandlers {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async handleRequest(params) {
        try {
            switch (params.method) {
                case "multiclaws.memory.search": {
                    const parsed = memorySearchPayloadSchema.safeParse(params.payload);
                    if (!parsed.success) {
                        return { ok: false, error: "query required" };
                    }
                    const result = await this.deps.memoryService.handleInboundSearch({
                        fromPeerId: params.fromPeerId,
                        fromPeerDisplayName: params.fromPeerDisplayName,
                        query: parsed.data.query,
                        maxResults: parsed.data.maxResults,
                    });
                    return { ok: true, data: result };
                }
                case "multiclaws.task.delegate": {
                    const parsed = delegatePayloadSchema.safeParse(params.payload);
                    if (!parsed.success) {
                        return { ok: false, error: "task required" };
                    }
                    const result = await this.deps.taskService.acceptDelegatedTask({
                        fromPeerId: params.fromPeerId,
                        fromPeerDisplayName: params.fromPeerDisplayName,
                        task: parsed.data.task,
                        context: parsed.data.context,
                    });
                    if (result.taskId) {
                        await this.deps.onTaskCompleted?.({
                            requesterPeerId: params.fromPeerId,
                            requestId: params.requestId,
                            task: parsed.data.task,
                            result: {
                                ok: result.ok,
                                taskId: result.taskId,
                                output: result.output,
                                error: result.error,
                            },
                        });
                    }
                    return { ok: result.ok, data: result, error: result.error };
                }
                case "multiclaws.message.forward": {
                    const parsed = directMessagePayloadSchema.safeParse(params.payload);
                    if (!parsed.success) {
                        return { ok: false, error: "message text required" };
                    }
                    await this.deps.onDirectMessage(parsed.data);
                    return { ok: true, data: { delivered: true } };
                }
                default:
                    return { ok: false, error: `unsupported method: ${params.method}` };
            }
        }
        catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
exports.MulticlawsProtocolHandlers = MulticlawsProtocolHandlers;
