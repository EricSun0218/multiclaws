import { type Attributes } from "@opentelemetry/api";
export declare function initializeTelemetry(params?: {
    enableConsoleExporter?: boolean;
}): void;
export declare function withSpan<T>(name: string, attrs: Attributes, fn: () => Promise<T>): Promise<T>;
