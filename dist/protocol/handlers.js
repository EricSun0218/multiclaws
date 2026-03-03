"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MulticlawsProtocolHandlers = void 0;
class MulticlawsProtocolHandlers {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async handleRequest(params) {
        try {
            switch (params.method) {
                case "multiclaws.memory.search": {
                    const payload = params.payload;
                    if (!payload?.query || typeof payload.query !== "string") {
                        return { ok: false, error: "query required" };
                    }
                    const result = await this.deps.memoryService.handleInboundSearch({
                        fromPeerId: params.fromPeerId,
                        fromPeerDisplayName: params.fromPeerDisplayName,
                        query: payload.query,
                        maxResults: payload.maxResults,
                    });
                    return { ok: true, data: result };
                }
                case "multiclaws.task.delegate": {
                    const payload = params.payload;
                    if (!payload?.task || typeof payload.task !== "string") {
                        return { ok: false, error: "task required" };
                    }
                    const result = await this.deps.taskService.acceptDelegatedTask({
                        fromPeerId: params.fromPeerId,
                        fromPeerDisplayName: params.fromPeerDisplayName,
                        task: payload.task,
                        context: payload.context,
                    });
                    if (result.taskId) {
                        await this.deps.onTaskCompleted?.({
                            requesterPeerId: params.fromPeerId,
                            requestId: params.requestId,
                            task: payload.task,
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
                    const payload = params.payload;
                    if (!payload?.text || typeof payload.text !== "string") {
                        return { ok: false, error: "message text required" };
                    }
                    await this.deps.onDirectMessage(payload);
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
