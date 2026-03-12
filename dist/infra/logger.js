"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noopLogger = void 0;
exports.createStructuredLogger = createStructuredLogger;
exports.noopLogger = {
    info: () => { },
    warn: () => { },
    error: () => { },
    debug: () => { },
};
/**
 * Creates a structured logger that delegates to OpenClaw's base logger.
 * Only outputs via baseLogger to avoid duplicate stdout writes.
 */
function createStructuredLogger(baseLogger, _name = "multiclaws") {
    const bridge = {
        info: (message) => baseLogger.info(message),
        warn: (message) => baseLogger.warn(message),
        error: (message) => baseLogger.error(message),
        debug: (message) => baseLogger.debug?.(message),
    };
    return {
        logger: bridge,
    };
}
