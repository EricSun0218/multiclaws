import pino, { type Logger } from "pino";

export type BasicLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

export function createStructuredLogger(baseLogger: BasicLogger, name = "multiclaws") {
  const level = process.env.MULTICLAWS_LOG_LEVEL ?? "info";
  const pinoLogger = pino({
    name,
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  const bridge: BasicLogger = {
    info: (message) => {
      pinoLogger.info({ source: "plugin" }, message);
      baseLogger.info(message);
    },
    warn: (message) => {
      pinoLogger.warn({ source: "plugin" }, message);
      baseLogger.warn(message);
    },
    error: (message) => {
      pinoLogger.error({ source: "plugin" }, message);
      baseLogger.error(message);
    },
    debug: (message) => {
      pinoLogger.debug({ source: "plugin" }, message);
      baseLogger.debug?.(message);
    },
  };

  return {
    pino: pinoLogger,
    logger: bridge,
    child(bindings: Record<string, string | number | boolean>): Logger {
      return pinoLogger.child(bindings);
    },
  };
}
