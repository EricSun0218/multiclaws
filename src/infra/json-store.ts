import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import lockfile from "proper-lockfile";

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 1.5,
    minTimeout: 50,
    maxTimeout: 1_000,
    randomize: true,
  },
  stale: 10_000,
} as const;

export async function ensureJsonFile(filePath: string, fallback: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonAtomically(filePath, fallback);
  }
}

export async function readJsonWithFallback<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export async function withJsonLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}
