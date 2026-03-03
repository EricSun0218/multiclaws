"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeFrame = encodeFrame;
exports.decodeFrame = decodeFrame;
function encodeFrame(frame) {
    return JSON.stringify(frame);
}
function decodeFrame(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.type !== "string") {
            return null;
        }
        return parsed;
    }
    catch {
        return null;
    }
}
