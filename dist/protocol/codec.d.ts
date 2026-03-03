import type { MulticlawsFrame } from "./types";
export declare function encodeFrame(frame: MulticlawsFrame): string;
export declare function decodeFrame(raw: string): MulticlawsFrame | null;
