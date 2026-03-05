export declare function ensureJsonFile(filePath: string, fallback: unknown): Promise<void>;
export declare function readJsonWithFallback<T>(filePath: string, fallback: T): Promise<T>;
export declare function writeJsonAtomically(filePath: string, value: unknown): Promise<void>;
export declare function withJsonLock<T>(filePath: string, fallback: unknown, fn: () => Promise<T>): Promise<T>;
