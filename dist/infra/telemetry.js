"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeTelemetry = initializeTelemetry;
exports.withSpan = withSpan;
const api_1 = require("@opentelemetry/api");
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
const tracer = api_1.trace.getTracer("multiclaws", "0.3.0");
async function withSpan(name, attrs, fn) {
    const span = tracer.startSpan(name, { attributes: attrs });
    return await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
        try {
            const result = await fn();
            span.setStatus({ code: api_1.SpanStatusCode.OK });
            return result;
        }
        catch (error) {
            span.recordException(error);
            span.setStatus({
                code: api_1.SpanStatusCode.ERROR,
                message: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        finally {
            span.end();
        }
    });
}
