export type PeerTrustLevel = "unknown" | "pending" | "trusted" | "blocked";
export type PeerCapability = "messaging.send" | "messaging.receive" | "memory.search" | "task.delegate" | "task.accept";
export type PeerRecord = {
    peerId: string;
    displayName: string;
    address: string;
    publicKey?: string;
    trustLevel: PeerTrustLevel;
    capabilities: PeerCapability[];
    lastSeenAtMs?: number;
    updatedAtMs: number;
};
export declare class PeerRegistry {
    private readonly filePath;
    constructor(filePath?: string);
    private readStore;
    list(): Promise<PeerRecord[]>;
    get(peerId: string): Promise<PeerRecord | null>;
    findByDisplayName(nameOrId: string): Promise<PeerRecord | null>;
    upsert(record: Omit<PeerRecord, "updatedAtMs">): Promise<PeerRecord>;
    remove(peerId: string): Promise<boolean>;
    setTrust(peerId: string, trustLevel: PeerTrustLevel): Promise<PeerRecord | null>;
    touchSeen(peerId: string): Promise<void>;
    get path(): string;
    close(): void;
}
