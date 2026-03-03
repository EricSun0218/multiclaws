"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatPermissionPrompt = formatPermissionPrompt;
function formatPermissionPrompt(params) {
    return [
        `[协作请求] ${params.peerDisplayName} 请求执行: ${params.action}`,
        `上下文: ${params.context}`,
        `请求ID: ${params.requestId}`,
        "回复方式:",
        `  /mc allow ${params.requestId} once`,
        `  /mc allow ${params.requestId} permanent`,
        `  /mc deny ${params.requestId}`,
    ].join("\n");
}
