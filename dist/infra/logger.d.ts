import pino, { type Logger } from "pino";
export type BasicLogger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
};
export declare function createStructuredLogger(baseLogger: BasicLogger, name?: string): {
    pino: pino.Logger<never, boolean>;
    logger: BasicLogger;
    child(bindings: Record<string, string | number | boolean>): Logger;
};
