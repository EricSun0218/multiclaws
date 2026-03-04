import { SpanStatusCode, context, trace, type Attributes } from "@opentelemetry/api";
import { ConsoleSpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

let initialized = false;

export function initializeTelemetry(params?: { enableConsoleExporter?: boolean }): void {
  if (initialized) {
    return;
  }

  const spanProcessors =
    (params?.enableConsoleExporter || process.env.MULTICLAWS_OTEL_CONSOLE === "1")
      ? [new SimpleSpanProcessor(new ConsoleSpanExporter())]
      : [];
  const provider = new NodeTracerProvider({ spanProcessors });
  provider.register();
  initialized = true;
}

const tracer = trace.getTracer("multiclaws", "0.2.0");

export async function withSpan<T>(name: string, attrs: Attributes, fn: () => Promise<T>): Promise<T> {
  const span = tracer.startSpan(name, { attributes: attrs });
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}
