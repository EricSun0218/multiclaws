import type { TaskTracker } from "./tracker";
import type { PermissionManager } from "../permission/manager";

export type TaskExecutionResult = {
  ok: boolean;
  output?: string;
  error?: string;
};

export type TaskExecutor = (params: {
  task: string;
  context?: string;
  fromPeerId: string;
}) => Promise<TaskExecutionResult>;

export class TaskDelegationService {
  constructor(
    private readonly tracker: TaskTracker,
    private readonly permissionManager: PermissionManager,
    private readonly executor: TaskExecutor,
  ) {}

  async acceptDelegatedTask(params: {
    fromPeerId: string;
    fromPeerDisplayName: string;
    task: string;
    context?: string;
  }): Promise<TaskExecutionResult & { taskId: string }> {
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
