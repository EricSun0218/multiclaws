"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskDelegationService = void 0;
class TaskDelegationService {
    tracker;
    permissionManager;
    executor;
    constructor(tracker, permissionManager, executor) {
        this.tracker = tracker;
        this.permissionManager = permissionManager;
        this.executor = executor;
    }
    async acceptDelegatedTask(params) {
        const decision = await this.permissionManager.evaluateRequest({
            peerId: params.fromPeerId,
            peerDisplayName: params.fromPeerDisplayName,
            action: "task.delegate",
            context: params.task,
        });
        if (decision === "deny") {
            return {
                ok: false,
                error: "permission denied",
                taskId: "",
            };
        }
        const track = this.tracker.create({
            fromPeerId: params.fromPeerId,
            toPeerId: "local",
            task: params.task,
            context: params.context,
        });
        this.tracker.update(track.taskId, { status: "running" });
        const result = await this.executor({
            task: params.task,
            context: params.context,
            fromPeerId: params.fromPeerId,
        });
        this.tracker.update(track.taskId, {
            status: result.ok ? "completed" : "failed",
            result: result.output,
            error: result.error,
        });
        return {
            ...result,
            taskId: track.taskId,
        };
    }
}
exports.TaskDelegationService = TaskDelegationService;
