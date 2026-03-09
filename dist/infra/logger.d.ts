export type BasicLogger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
};
/**
 * Creates a structured logger that delegates to OpenClaw's base logger.
 * Only outputs via baseLogger to avoid duplicate stdout writes.
 */
export declare function createStructuredLogger(baseLogger: BasicLogger, _name?: string): {
    logger: BasicLogger;
};
