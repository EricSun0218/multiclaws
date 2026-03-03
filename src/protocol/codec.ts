import type { MulticlawsFrame } from "./types";

export function encodeFrame(frame: MulticlawsFrame): string {
  return JSON.stringify(frame);
}

export function decodeFrame(raw: string): MulticlawsFrame | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string };
    if (!parsed || typeof parsed.type !== "string") {
      return null;
    }
    return parsed as MulticlawsFrame;
  } catch {
    return null;
  }
}
