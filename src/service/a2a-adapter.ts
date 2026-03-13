import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { invokeGatewayTool, type GatewayConfig } from "../infra/gateway-client";
import type { TaskTracker } from "../task/tracker";
import type { NotificationTarget } from "./multiclaws-service";

export type A2AAdapterOptions = {
  gatewayConfig: GatewayConfig | null;
  taskTracker: TaskTracker;
  cwd?: string;
  getNotificationTargets?: () => ReadonlyMap<string, NotificationTarget>;
  /** Called when a session is discovered via fallback; allows service to cache it for future use. */
  registerDiscoveredTarget?: (sessionKey: string) => void;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

type PendingCallback = {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingApproval = {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/* ------------------------------------------------------------------ */
/*  Risk classification                                                */
/* ------------------------------------------------------------------ */

/**
 * Heuristic risk classifier. Returns "safe" only when the task is
 * clearly a read-only query; defaults to "risky" for anything ambiguous.
 *
 * This drives the permission gate: risky tasks require explicit human
 * approval before a sub-agent is spawned to execute them.
 */
function classifyTaskRisk(taskText: string): "safe" | "risky" {
  const text = taskText.toLowerCase();

  // Explicit risky patterns (write / modify / execute / send)
  const riskyPatterns = [
    // English — word-boundary matched to avoid false positives
    /\b(write|creat|delet|remov|modif|edit|updat|install|execut|deploy|push|commit|send|post|drop|format|rename|overwrite|reset|wipe|destroy|kill|terminat|rm|mkdir|touch|mv)\b/i,
    // Chinese — multi-character phrases to avoid single-char false positives
    // e.g. 安 alone would match 安排(schedule) or 安全(safe)
    /写入|写文件|写邮件|写信|创建|新建|删除|移除|修改|更改|编辑|更新|升级|安装|部署|执行|运行命令|发送|发邮件|提交|推送|重命名|覆盖|重置|清空|清除|销毁|终止|停止服务|kill进程/,
  ];

  // Explicitly safe read-only patterns — checked BEFORE risky to avoid false positives
  // (e.g. "查询并发送报告" is risky overall, but "查询" alone should be safe)
  const safePatterns = [
    // English read-only verbs
    /\b(list|show|get|check|view|read|query|find|search|display|fetch|retriev|look|what|which|count|how many|summariz|describ|explain|analyz|report)\b/i,
    // Chinese read-only verbs (multi-char to be specific)
    /查看|查询|获取|搜索|显示|检查|列出|列举|统计|描述|分析|报告|读取|浏览/,
    // Calendar / scheduling queries
    /\b(calendar|schedule|event|meeting|free|busy|availab|appointment)\b/i,
    /日历|日程|会议|空闲|忙碌|可用时间|时间段|什么时候|哪个时间|安排会议|约会|预约/,
    // Process / system info queries
    /\b(process|pid|cpu|memory|disk|uptime|version|status|running|service|log)\b/i,
    /进程|内存|磁盘|系统状态|运行状态|版本信息|日志|监控/,
  ];

  // Safe check first — if clearly a read query, don't let ambiguous chars trigger risky
  if (safePatterns.some((p) => p.test(text))) {
    return "safe";
  }

  if (riskyPatterns.some((p) => p.test(text))) {
    return "risky";
  }

  // Default: treat as risky if uncertain
  return "risky";
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function extractTextFromMessage(message: Message): string {
  if (!message.parts) return "";
  return message.parts
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Bridges the A2A protocol to OpenClaw's sessions_spawn gateway tool.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Classifies the task risk (safe vs risky)
 * 2. Notifies the local human owner
 * 3. For risky tasks: waits for explicit human approval
 *    For safe tasks: executes immediately
 * 4. Calls OpenClaw's `sessions_spawn` (run mode) to start execution
 * 5. Waits for the sub-agent to call back via `multiclaws_a2a_callback`
 * 6. Returns the final result as a Message
 */
export class OpenClawAgentExecutor implements AgentExecutor {
  private gatewayConfig: GatewayConfig | null;
  private readonly taskTracker: TaskTracker;
  private readonly getNotificationTargets: () => ReadonlyMap<string, NotificationTarget>;
  private readonly registerDiscoveredTarget: ((sessionKey: string) => void) | undefined;
  private readonly logger: A2AAdapterOptions["logger"];
  private readonly cwd: string;
  private readonly pendingCallbacks = new Map<string, PendingCallback>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(options: A2AAdapterOptions) {
    this.gatewayConfig = options.gatewayConfig;
    this.taskTracker = options.taskTracker;
    this.getNotificationTargets = options.getNotificationTargets ?? (() => new Map());
    this.registerDiscoveredTarget = options.registerDiscoveredTarget;
    this.logger = options.logger;
    this.cwd = options.cwd || process.cwd();
  }

  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskText = extractTextFromMessage(context.userMessage);
    const taskId = context.taskId;

    this.logger.info(`[a2a-adapter] ▶ execute() called — taskId=${taskId}, textLen=${taskText.length}`);

    if (!taskText.trim()) {
      this.logger.warn(`[a2a-adapter] ✗ empty task text, rejecting — taskId=${taskId}`);
      this.publishMessage(eventBus, "Error: empty task received.");
      eventBus.finished();
      return;
    }

    const meta = context.userMessage.metadata ?? {};
    const fromAgentUrl = (meta.agentUrl as string) ?? "unknown";
    const fromAgentName = (meta.agentName as string) || fromAgentUrl;

    this.logger.info(
      `[a2a-adapter] task ${taskId} from ${fromAgentName} (${fromAgentUrl}): ${taskText.slice(0, 120)}`,
    );

    this.taskTracker.create({
      fromPeerId: fromAgentUrl,
      toPeerId: "local",
      task: taskText,
    });
    this.logger.info(`[a2a-adapter] task ${taskId} tracked`);

    if (!this.gatewayConfig) {
      this.logger.error(`[a2a-adapter] ✗ gateway config not available — taskId=${taskId}`);
      this.taskTracker.update(taskId, { status: "failed", error: "gateway config not available" });
      this.publishMessage(eventBus, "Error: gateway config not available, cannot execute task.");
      eventBus.finished();
      return;
    }

    // Classify risk and gate accordingly
    const risk = classifyTaskRisk(taskText);
    this.logger.info(`[a2a-adapter] task ${taskId} risk=${risk}`);

    if (risk === "risky") {
      // Notify with approval request and wait
      const approvalTimeoutMs = 5 * 60 * 1000; // 5 minutes
      const approvalPromise = this.createApprovalCallback(taskId, approvalTimeoutMs);

      this.logger.info(`[a2a-adapter] task ${taskId} requesting human approval (timeout=${approvalTimeoutMs / 1000}s)`);
      void this.notifyUser(buildApprovalRequest(taskId, fromAgentName, taskText));

      let approved: boolean;
      try {
        approved = await approvalPromise;
      } catch (err) {
        const isCanceled = err instanceof Error && err.message === "canceled";
        if (isCanceled) {
          // Task was explicitly canceled — use the canonical "canceled" message
          this.logger.info(`[a2a-adapter] task ${taskId} canceled during approval wait`);
          this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
          this.publishMessage(eventBus, "Task was canceled.");
          eventBus.finished();
          return;
        }
        // Approval timed out → auto-reject
        approved = false;
        this.logger.warn(`[a2a-adapter] task ${taskId} approval timed out — auto-rejected`);
      }

      if (!approved) {
        const reason = "用户拒绝或未在超时时间内授权。";
        this.logger.info(`[a2a-adapter] task ${taskId} rejected`);
        this.taskTracker.update(taskId, { status: "failed", error: reason });
        this.publishMessage(eventBus, `任务已被拒绝：${reason}`);
        eventBus.finished();
        return;
      }

      this.logger.info(`[a2a-adapter] task ${taskId} approved by user`);
      void this.notifyUser(`✅ 已授权，开始执行来自 **${fromAgentName}** 的任务…`);
    } else {
      // Safe task: notify but auto-execute
      this.logger.info(`[a2a-adapter] task ${taskId} safe query — auto-executing`);
      void this.notifyUser(
        `📨 收到来自 **${fromAgentName}** 的查询任务（安全，自动执行）：\n\n${taskText.slice(0, 300)}`,
      );
    }

    try {
      // Create a promise that resolves when sub-agent calls multiclaws_a2a_callback
      const timeoutMs = 180_000;
      const resultPromise = this.createCallback(taskId, timeoutMs);
      this.logger.info(
        `[a2a-adapter] task ${taskId} callback registered (timeout=${timeoutMs / 1000}s)`,
      );

      // Spawn the subagent with instructions to call back when done
      const prompt = buildA2ASubagentPrompt(taskId, taskText);
      this.logger.info(
        `[a2a-adapter] task ${taskId} spawning sub-agent via sessions_spawn (cwd=${this.cwd}, sessionKey=a2a-${taskId})`,
      );

      const spawnResult = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_spawn",
        args: {
          task: prompt,
          mode: "run",
          cwd: this.cwd,
        },
        sessionKey: `a2a-${taskId}`,
        timeoutMs: 15_000,
      });
      this.logger.info(
        `[a2a-adapter] task ${taskId} sub-agent spawned — result=${JSON.stringify(spawnResult).slice(0, 200)}`,
      );

      this.logger.info(`[a2a-adapter] task ${taskId} waiting for callback from sub-agent...`);

      // Wait for the sub-agent to call back
      const output = await resultPromise;

      // Return result and notify user
      this.taskTracker.update(taskId, { status: "completed", result: output });
      this.logger.info(
        `[a2a-adapter] ✓ task ${taskId} completed — resultLen=${output.length}, preview=${output.slice(0, 120)}`,
      );
      void this.notifyUser(
        `✅ **来自 ${fromAgentName} 的任务已完成**\n\n${output.slice(0, 800)}`,
      );
      this.publishMessage(eventBus, output || "Task completed with no output.");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[a2a-adapter] ✗ task ${taskId} failed: ${errorMsg}`);
      this.taskTracker.update(taskId, { status: "failed", error: errorMsg });
      void this.notifyUser(`❌ 来自 **${fromAgentName}** 的任务执行失败：${errorMsg}`);
      this.publishMessage(eventBus, `Error: ${errorMsg}`);
    }

    this.logger.info(`[a2a-adapter] task ${taskId} eventBus.finished()`);
    eventBus.finished();
  }

  /**
   * Called by the `multiclaws_a2a_callback` tool when a sub-agent reports its result.
   * Returns true if a pending callback was found and resolved.
   */
  resolveCallback(taskId: string, result: string): boolean {
    const pending = this.pendingCallbacks.get(taskId);
    if (!pending) {
      this.logger.warn(
        `[a2a-adapter] resolveCallback: no pending callback for taskId=${taskId} (may have timed out)`,
      );
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingCallbacks.delete(taskId);
    this.logger.info(
      `[a2a-adapter] resolveCallback: taskId=${taskId} resolved — resultLen=${result.length}`,
    );
    pending.resolve(result);
    return true;
  }

  /**
   * Called when the local human owner approves or rejects a pending risky task.
   * Returns true if a pending approval was found.
   */
  resolveApproval(taskId: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(taskId);
    if (!pending) {
      this.logger.warn(
        `[a2a-adapter] resolveApproval: no pending approval for taskId=${taskId}`,
      );
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingApprovals.delete(taskId);
    this.logger.info(
      `[a2a-adapter] resolveApproval: taskId=${taskId} approved=${approved}`,
    );
    pending.resolve(approved);
    return true;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.logger.info(`[a2a-adapter] cancelTask(taskId=${taskId})`);
    // Reject pending approval if any — distinct from user-rejection, uses Error("canceled")
    const approval = this.pendingApprovals.get(taskId);
    if (approval) {
      clearTimeout(approval.timer);
      this.pendingApprovals.delete(taskId);
      approval.reject(new Error("canceled"));
      this.logger.info(`[a2a-adapter] cancelTask: pending approval canceled for taskId=${taskId}`);
    }
    // Reject pending callback if any
    const pending = this.pendingCallbacks.get(taskId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingCallbacks.delete(taskId);
      pending.reject(new Error("canceled"));
      this.logger.info(`[a2a-adapter] cancelTask: pending callback rejected for taskId=${taskId}`);
    }
    this.taskTracker.update(taskId, { status: "failed", error: "canceled" });
    this.publishMessage(eventBus, "Task was canceled.");
    eventBus.finished();
  }

  updateGatewayConfig(config: GatewayConfig): void {
    this.gatewayConfig = config;
  }

  /**
   * Create a pending callback that resolves when the sub-agent reports back,
   * or rejects on timeout.
   */
  private createCallback(taskId: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCallbacks.delete(taskId);
        this.logger.error(
          `[a2a-adapter] ✗ task ${taskId} callback timed out after ${timeoutMs / 1000}s — pending callbacks remaining: ${this.pendingCallbacks.size}`,
        );
        reject(new Error(`task timed out after ${timeoutMs / 1000}s waiting for sub-agent callback`));
      }, timeoutMs);

      this.pendingCallbacks.set(taskId, { resolve, reject, timer });
    });
  }

  /**
   * Create a pending approval that resolves when the human owner responds,
   * or rejects on timeout or cancellation.
   */
  private createApprovalCallback(taskId: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(taskId);
        this.logger.warn(
          `[a2a-adapter] task ${taskId} approval timed out after ${timeoutMs / 1000}s`,
        );
        reject(new Error(`approval timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this.pendingApprovals.set(taskId, { resolve, reject, timer });
    });
  }

  /**
   * Discover the most recently active non-internal session via sessions_list.
   * Used as fallback when no notification targets have been registered yet
   * (e.g. right after a gateway restart before the user sends their first message).
   */
  private async discoverActiveSession(): Promise<string | null> {
    if (!this.gatewayConfig) return null;
    try {
      const raw = await invokeGatewayTool({
        gateway: this.gatewayConfig,
        tool: "sessions_list",
        args: { limit: 10, activeMinutes: 120 },
        timeoutMs: 5_000,
      });

      this.logger.info(`[a2a-adapter] discoverActiveSession: raw result = ${JSON.stringify(raw).slice(0, 500)}`);

      // Unwrap gateway tool standard response: { content: [{ type: "text", text: "..." }] }
      let parsed: any = raw;
      if ((raw as any)?.content?.[0]?.type === "text") {
        try { parsed = JSON.parse((raw as any).content[0].text); } catch { /* use raw */ }
      }

      const sessions: Array<Record<string, unknown>> = parsed?.sessions ?? [];
      this.logger.info(`[a2a-adapter] discoverActiveSession: found ${sessions.length} sessions`);

      const INTERNAL_PREFIXES = ["delegate-", "a2a-"];
      // sessions_list returns "key" not "sessionKey"
      const session = sessions.find((s) => {
        const k = (s.key ?? s.sessionKey) as string | undefined;
        return k && !INTERNAL_PREFIXES.some((p) => k.startsWith(p));
      });

      const matchedKey = (session?.key ?? session?.sessionKey) as string | undefined;
      if (matchedKey) {
        this.logger.info(`[a2a-adapter] discoverActiveSession: matched session ${matchedKey}`);
      } else {
        this.logger.warn(`[a2a-adapter] discoverActiveSession: all ${sessions.length} sessions filtered or empty`);
        sessions.forEach((s) => this.logger.info(`[a2a-adapter]   session: ${(s.key ?? s.sessionKey) ?? "(no key)"}`));
      }
      return matchedKey ?? null;
    } catch (err) {
      this.logger.warn(
        `[a2a-adapter] discoverActiveSession failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Send a notification to all known targets. Individual failures are silently ignored. */
  private async notifyUser(message: string): Promise<void> {
    const targets = this.getNotificationTargets();
    if (!this.gatewayConfig) {
      this.logger.info(`[a2a-adapter] notifyUser: skipped (no gateway config)`);
      return;
    }

    // Fallback: no registered targets yet (e.g. right after gateway restart).
    // Discover the active session and send directly via sessions_send.
    if (targets.size === 0) {
      this.logger.info(`[a2a-adapter] notifyUser: no registered targets — attempting session discovery`);
      const sessionKey = await this.discoverActiveSession();
      if (sessionKey) {
        this.logger.info(`[a2a-adapter] notifyUser: discovered session ${sessionKey}, sending via sessions_send`);
        try {
          await invokeGatewayTool({
            gateway: this.gatewayConfig,
            tool: "sessions_send",
            args: { sessionKey, message },
            timeoutMs: 5_000,
          });
          // Also register this session for future notifications
          if (this.registerDiscoveredTarget) {
            this.registerDiscoveredTarget(sessionKey);
          }
        } catch (err) {
          this.logger.warn(
            `[a2a-adapter] notifyUser: sessions_send to ${sessionKey} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.logger.warn(`[a2a-adapter] notifyUser: no active session found, message lost`);
      }
      return;
    }

    const results = await Promise.allSettled(
      [...targets.entries()].map(async ([key, target]) => {
        this.logger.info(`[a2a-adapter] notifyUser: sending to ${key} (type=${target.type})`);
        try {
          await (target.type === "channel"
            ? invokeGatewayTool({
                gateway: this.gatewayConfig!,
                tool: "message",
                args: { action: "send", target: target.conversationId, message },
                timeoutMs: 5_000,
              })
            : invokeGatewayTool({
                // sessions_send injects a message into the session so the AI
                // can relay it to the human (correct tool; was "chat.send" before)
                gateway: this.gatewayConfig!,
                tool: "sessions_send",
                args: { sessionKey: target.sessionKey, message },
                timeoutMs: 5_000,
              }));
          this.logger.info(`[a2a-adapter] notifyUser: sent to ${key} ✓`);
        } catch (err) {
          this.logger.warn(
            `[a2a-adapter] notifyUser: failed to send to ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err;
        }
      }),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    this.logger.info(`[a2a-adapter] notifyUser: done (${ok} ok, ${fail} failed)`);
  }

  private publishMessage(eventBus: ExecutionEventBus, text: string): void {
    const message: Message = {
      kind: "message",
      role: "agent",
      messageId: `msg-${Date.now()}`,
      parts: [{ kind: "text", text }],
    };
    eventBus.publish(message);
  }
}

/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */

/**
 * Build the approval request message injected into the human's active session.
 * The AI in that session will relay it and handle the human's approve/reject response.
 */
function buildApprovalRequest(taskId: string, fromAgentName: string, taskText: string): string {
  const preview = taskText.length > 600 ? taskText.slice(0, 600) + "…" : taskText;
  return `[MultiClaws] 收到来自 **${fromAgentName}** 的委派任务，需要授权

**任务内容：**
${preview}

⚠️ 该任务涉及写操作或高风险操作，需要您授权才能执行。

请询问用户是否同意执行，并根据回复调用对应工具：
- 同意：\`multiclaws_task_respond(taskId="${taskId}", approved=true)\`
- 拒绝：\`multiclaws_task_respond(taskId="${taskId}", approved=false)\`

授权等待时间：5 分钟，超时自动拒绝。`;
}

/**
 * Build the prompt for the sub-agent that handles an incoming A2A task.
 * The sub-agent must call `multiclaws_a2a_callback` to report its result.
 */
function buildA2ASubagentPrompt(taskId: string, taskText: string): string {
  return `你收到了一个来自远端智能体的委派任务。请完成任务并汇报结果。

## 任务内容

${taskText}

## 完成后必做

完成任务后，你**必须**调用 \`multiclaws_a2a_callback\` 工具汇报结果：

\`\`\`
multiclaws_a2a_callback(taskId="${taskId}", result="你的完整回复内容")
\`\`\`

**重要**：
- 无论任务成功还是失败，都必须调用 \`multiclaws_a2a_callback\`
- result 参数填写你的完整回复文本
- 如果任务失败，在 result 中说明失败原因
- 这是唯一的结果回传方式，不调用则结果会丢失`;
}
