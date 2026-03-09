"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTelemetry = initializeTelemetry;
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const sdk_trace_node_1 = require("@opentelemetry/sdk-trace-node");
let initialized = false;
function initializeTelemetry(params) {
    if (initialized) {
        return;
    }
    const spanProcessors = (params?.enableConsoleExporter || process.env.MULTICLAWS_OTEL_CONSOLE === "1")
        ? [new sdk_trace_base_1.SimpleSpanProcessor(new sdk_trace_base_1.ConsoleSpanExporter())]
        : [];
    const provider = new sdk_trace_node_1.NodeTracerProvider({ spanProcessors });
    provider.register();
    initialized = true;
}
