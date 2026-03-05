"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStructuredLogger = createStructuredLogger;
const pino_1 = __importDefault(require("pino"));
function createStructuredLogger(baseLogger, name = "multiclaws") {
    const level = process.env.MULTICLAWS_LOG_LEVEL ?? "info";
    const pinoLogger = (0, pino_1.default)({
        name,
        level,
        base: undefined,
        timestamp: pino_1.default.stdTimeFunctions.isoTime,
    });
    const bridge = {
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
        child(bindings) {
            return pinoLogger.child(bindings);
        },
    };
}
