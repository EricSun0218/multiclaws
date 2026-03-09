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
