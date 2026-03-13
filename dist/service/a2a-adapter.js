"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenClawAgentExecutor = void 0;
const gateway_client_1 = require("../infra/gateway-client");
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
function classifyTaskRisk(taskText) {
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
function extractTextFromMessage(message) {
    if (!message.parts)
        return "";
    return message.parts
        .filter((p) => p.kind === "text")
        .map((p) => p.text)
        .join("\n");
}
/**
 * Bridges the A2A protocol to OpenClaw's session injection mechanism.
 *
 * When a remote agent sends a task via A2A `message/send`,
 * this executor:
 * 1. Classifies the task risk (safe vs risky)
 * 2. For risky tasks: pushes approval request to the user's active session and waits
 *    For safe tasks: proceeds immediately
 * 3. Finds the target session (where user last sent a message, or main session)
 * 4. Injects the task into that session via sessions_send — no isolated sub-session created
 * 5. Waits for the session AI to call back via `multiclaws_a2a_callback`
 * 6. Returns the final result as a Message
 */
class OpenClawAgentExecutor {
    gatewayConfig;
    taskTracker;
    getNotificationTargets;
    registerDiscoveredTarget;
    logger;
    cwd;
    pendingCallbacks = new Map();
    pendingApprovals = new Map();
    constructor(options) {
        this.gatewayConfig = options.gatewayConfig;
        this.taskTracker = options.taskTracker;
        this.getNotificationTargets = options.getNotificationTargets ?? (() => new Map());
        this.registerDiscoveredTarget = options.registerDiscoveredTarget;
        this.logger = options.logger;
        this.cwd = options.cwd || process.cwd();
    }
    async execute(context, eventBus) {
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
        const fromAgentUrl = meta.agentUrl ?? "unknown";
        const fromAgentName = meta.agentName || fromAgentUrl;
        this.logger.info(`[a2a-adapter] task ${taskId} from ${fromAgentName} (${fromAgentUrl}): ${taskText.slice(0, 120)}`);
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
            let approved;
            try {
                approved = await approvalPromise;
            }
            catch (err) {
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
        }
        else {
            // Safe task: auto-execute — task will appear directly in target session, no separate notification needed
            this.logger.info(`[a2a-adapter] task ${taskId} safe query — auto-executing`);
        }
        // Find the target session: prefer session where user last sent a message, fall back to main session
        const targetSessionKey = await this.findTargetSession();
        if (!targetSessionKey) {
            const errMsg = "无法找到用户活跃 session，任务未执行。请确保至少有一个活跃的对话 session。";
            this.logger.error(`[a2a-adapter] ✗ task ${taskId} no target session found — aborting`);
            this.taskTracker.update(taskId, { status: "failed", error: errMsg });
            this.publishMessage(eventBus, errMsg);
            eventBus.finished();
            return;
        }
        try {
            // Create a promise that resolves when the target session AI calls multiclaws_a2a_callback
            const timeoutMs = 180_000;
            const resultPromise = this.createCallback(taskId, timeoutMs);
            this.logger.info(`[a2a-adapter] task ${taskId} callback registered (timeout=${timeoutMs / 1000}s)`);
            // Inject task directly into the target session — no isolated sub-session created
            const prompt = buildA2AMainSessionPrompt(taskId, fromAgentName, taskText);
            this.logger.info(`[a2a-adapter] task ${taskId} injecting into target session ${targetSessionKey} via sessions_send`);
            await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_send",
                args: { sessionKey: targetSessionKey, message: prompt },
                timeoutMs: 15_000,
            });
            this.logger.info(`[a2a-adapter] task ${taskId} injected — waiting for callback from target session...`);
            // Wait for the target session AI to call multiclaws_a2a_callback
            const output = await resultPromise;
            // Return result to delegating agent (result is already visible in target session)
            this.taskTracker.update(taskId, { status: "completed", result: output });
            this.logger.info(`[a2a-adapter] ✓ task ${taskId} completed — resultLen=${output.length}, preview=${output.slice(0, 120)}`);
            this.publishMessage(eventBus, output || "Task completed with no output.");
        }
        catch (err) {
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
    resolveCallback(taskId, result) {
        const pending = this.pendingCallbacks.get(taskId);
        if (!pending) {
            this.logger.warn(`[a2a-adapter] resolveCallback: no pending callback for taskId=${taskId} (may have timed out)`);
            return false;
        }
        clearTimeout(pending.timer);
        this.pendingCallbacks.delete(taskId);
        this.logger.info(`[a2a-adapter] resolveCallback: taskId=${taskId} resolved — resultLen=${result.length}`);
        pending.resolve(result);
        return true;
    }
    /**
     * Called when the local human owner approves or rejects a pending risky task.
     * Returns true if a pending approval was found.
     */
    resolveApproval(taskId, approved) {
        const pending = this.pendingApprovals.get(taskId);
        if (!pending) {
            this.logger.warn(`[a2a-adapter] resolveApproval: no pending approval for taskId=${taskId}`);
            return false;
        }
        clearTimeout(pending.timer);
        this.pendingApprovals.delete(taskId);
        this.logger.info(`[a2a-adapter] resolveApproval: taskId=${taskId} approved=${approved}`);
        pending.resolve(approved);
        return true;
    }
    async cancelTask(taskId, eventBus) {
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
    updateGatewayConfig(config) {
        this.gatewayConfig = config;
    }
    /**
     * Create a pending callback that resolves when the sub-agent reports back,
     * or rejects on timeout.
     */
    createCallback(taskId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingCallbacks.delete(taskId);
                this.logger.error(`[a2a-adapter] ✗ task ${taskId} callback timed out after ${timeoutMs / 1000}s — pending callbacks remaining: ${this.pendingCallbacks.size}`);
                reject(new Error(`task timed out after ${timeoutMs / 1000}s waiting for sub-agent callback`));
            }, timeoutMs);
            this.pendingCallbacks.set(taskId, { resolve, reject, timer });
        });
    }
    /**
     * Create a pending approval that resolves when the human owner responds,
     * or rejects on timeout or cancellation.
     */
    createApprovalCallback(taskId, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingApprovals.delete(taskId);
                this.logger.warn(`[a2a-adapter] task ${taskId} approval timed out after ${timeoutMs / 1000}s`);
                reject(new Error(`approval timed out after ${timeoutMs / 1000}s`));
            }, timeoutMs);
            this.pendingApprovals.set(taskId, { resolve, reject, timer });
        });
    }
    /**
     * Find the best target session for task injection:
     * 1. Prefer the session where the user most recently sent a message (role === "user")
     * 2. Fall back to the first non-internal active session (typically the main webchat session)
     * Never returns internal sessions (delegate-*, a2a-*).
     */
    async findTargetSession() {
        if (!this.gatewayConfig)
            return null;
        try {
            const raw = await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_list",
                args: { limit: 20, activeMinutes: 1440, messageLimit: 3 },
                timeoutMs: 5_000,
            });
            // Unwrap gateway tool standard response: { content: [{ type: "text", text: "..." }] }
            let parsed = raw;
            if (raw?.content?.[0]?.type === "text") {
                try {
                    parsed = JSON.parse(raw.content[0].text);
                }
                catch { /* use raw */ }
            }
            const INTERNAL_PREFIXES = ["delegate-", "a2a-"];
            const sessions = parsed?.sessions ?? [];
            const filtered = sessions.filter((s) => {
                const k = (s.key ?? s.sessionKey);
                return k && !INTERNAL_PREFIXES.some((p) => k.startsWith(p));
            });
            // Prefer sessions that have at least one user-originated message
            const withUserMsg = filtered.filter((s) => Array.isArray(s.messages) && s.messages.some((m) => m.role === "user"));
            // Fall back to any non-internal session (likely the main webchat session)
            const target = withUserMsg[0] ?? filtered[0];
            const targetKey = (target?.key ?? target?.sessionKey);
            this.logger.info(`[a2a-adapter] findTargetSession: found ${targetKey ?? "none"} (${withUserMsg.length} sessions with user messages, ${filtered.length} total)`);
            return targetKey ?? null;
        }
        catch (err) {
            this.logger.warn(`[a2a-adapter] findTargetSession failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    /**
     * Discover the most recently active non-internal session via sessions_list.
     * Used as fallback when no notification targets have been registered yet
     * (e.g. right after a gateway restart before the user sends their first message).
     */
    async discoverActiveSession() {
        if (!this.gatewayConfig)
            return null;
        try {
            const raw = await (0, gateway_client_1.invokeGatewayTool)({
                gateway: this.gatewayConfig,
                tool: "sessions_list",
                args: { limit: 10, activeMinutes: 120 },
                timeoutMs: 5_000,
            });
            this.logger.info(`[a2a-adapter] discoverActiveSession: raw result = ${JSON.stringify(raw).slice(0, 500)}`);
            // Unwrap gateway tool standard response: { content: [{ type: "text", text: "..." }] }
            let parsed = raw;
            if (raw?.content?.[0]?.type === "text") {
                try {
                    parsed = JSON.parse(raw.content[0].text);
                }
                catch { /* use raw */ }
            }
            const sessions = parsed?.sessions ?? [];
            this.logger.info(`[a2a-adapter] discoverActiveSession: found ${sessions.length} sessions`);
            const INTERNAL_PREFIXES = ["delegate-", "a2a-"];
            // sessions_list returns "key" not "sessionKey"
            const session = sessions.find((s) => {
                const k = (s.key ?? s.sessionKey);
                return k && !INTERNAL_PREFIXES.some((p) => k.startsWith(p));
            });
            const matchedKey = (session?.key ?? session?.sessionKey);
            if (matchedKey) {
                this.logger.info(`[a2a-adapter] discoverActiveSession: matched session ${matchedKey}`);
            }
            else {
                this.logger.warn(`[a2a-adapter] discoverActiveSession: all ${sessions.length} sessions filtered or empty`);
                sessions.forEach((s) => this.logger.info(`[a2a-adapter]   session: ${(s.key ?? s.sessionKey) ?? "(no key)"}`));
            }
            return matchedKey ?? null;
        }
        catch (err) {
            this.logger.warn(`[a2a-adapter] discoverActiveSession failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    /** Send a notification to all known targets. Individual failures are silently ignored. */
    async notifyUser(message) {
        const targets = this.getNotificationTargets();
        if (!this.gatewayConfig) {
            this.logger.info(`[a2a-adapter] notifyUser: skipped (no gateway config)`);
            return;
        }
        // Fallback: no registered targets yet (e.g. right after gateway restart).
        // Discover the active session and send directly via sessions_send.
        if (targets.size === 0) {
            this.logger.info(`[a2a-adapter] notifyUser: no registered targets — attempting session discovery`);
            const sessionKey = await this.findTargetSession();
            if (sessionKey) {
                this.logger.info(`[a2a-adapter] notifyUser: discovered session ${sessionKey}, sending via sessions_send`);
                try {
                    await (0, gateway_client_1.invokeGatewayTool)({
                        gateway: this.gatewayConfig,
                        tool: "sessions_send",
                        args: { sessionKey, message },
                        timeoutMs: 5_000,
                    });
                    // Also register this session for future notifications
                    if (this.registerDiscoveredTarget) {
                        this.registerDiscoveredTarget(sessionKey);
                    }
                }
                catch (err) {
                    this.logger.warn(`[a2a-adapter] notifyUser: sessions_send to ${sessionKey} failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            else {
                this.logger.warn(`[a2a-adapter] notifyUser: no active session found, message lost`);
            }
            return;
        }
        const results = await Promise.allSettled([...targets.entries()].map(async ([key, target]) => {
            this.logger.info(`[a2a-adapter] notifyUser: sending to ${key} (type=${target.type})`);
            try {
                await (target.type === "channel"
                    ? (0, gateway_client_1.invokeGatewayTool)({
                        gateway: this.gatewayConfig,
                        tool: "message",
                        args: { action: "send", target: target.conversationId, message },
                        timeoutMs: 5_000,
                    })
                    : (0, gateway_client_1.invokeGatewayTool)({
                        // sessions_send injects a message into the session so the AI
                        // can relay it to the human (correct tool; was "chat.send" before)
                        gateway: this.gatewayConfig,
                        tool: "sessions_send",
                        args: { sessionKey: target.sessionKey, message },
                        timeoutMs: 5_000,
                    }));
                this.logger.info(`[a2a-adapter] notifyUser: sent to ${key} ✓`);
            }
            catch (err) {
                this.logger.warn(`[a2a-adapter] notifyUser: failed to send to ${key}: ${err instanceof Error ? err.message : String(err)}`);
                throw err;
            }
        }));
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const fail = results.filter((r) => r.status === "rejected").length;
        this.logger.info(`[a2a-adapter] notifyUser: done (${ok} ok, ${fail} failed)`);
    }
    publishMessage(eventBus, text) {
        const message = {
            kind: "message",
            role: "agent",
            messageId: `msg-${Date.now()}`,
            parts: [{ kind: "text", text }],
        };
        eventBus.publish(message);
    }
}
exports.OpenClawAgentExecutor = OpenClawAgentExecutor;
/* ------------------------------------------------------------------ */
/*  Prompt builders                                                    */
/* ------------------------------------------------------------------ */
/**
 * Build the approval request message injected into the human's active session.
 * The AI in that session will relay it and handle the human's approve/reject response.
 */
function buildApprovalRequest(taskId, fromAgentName, taskText) {
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
 * Build the prompt injected into the user's active main session for an incoming A2A task.
 * The AI in that session processes the task naturally and must call multiclaws_a2a_callback.
 */
function buildA2AMainSessionPrompt(taskId, fromAgentName, taskText) {
    return `[MultiClaws 委派任务] 来自 **${fromAgentName}**：

${taskText}

---
完成后请调用 \`multiclaws_a2a_callback\` 汇报结果：
- taskId: "${taskId}"
- result: 你的完整回复内容

无论成功还是失败都必须调用，这是结果回传给委派方的唯一方式。`;
}
