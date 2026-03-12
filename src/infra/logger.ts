export type BasicLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export const noopLogger: BasicLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Creates a structured logger that delegates to OpenClaw's base logger.
 * Only outputs via baseLogger to avoid duplicate stdout writes.
 */
export function createStructuredLogger(baseLogger: BasicLogger, _name = "multiclaws") {
  const bridge: BasicLogger = {
    info: (message) => baseLogger.info(message),
    warn: (message) => baseLogger.warn(message),
    error: (message) => baseLogger.error(message),
    debug: (message) => baseLogger.debug?.(message),
  };

  return {
    logger: bridge,
  };
}
