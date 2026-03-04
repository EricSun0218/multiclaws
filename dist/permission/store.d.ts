import type { PeerPermissionRecord, PermissionMode } from "./types";
export declare class PermissionStore {
    private readonly filePath;
    constructor(filePath?: string);
    private readStore;
    get(peerId: string): Promise<PeerPermissionRecord | null>;
    list(): Promise<PeerPermissionRecord[]>;
    set(peerId: string, mode: PermissionMode): Promise<PeerPermissionRecord>;
    clear(peerId: string): Promise<void>;
    get path(): string;
    close(): void;
}
