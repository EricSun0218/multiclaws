import { EventEmitter } from "node:events";
export type Libp2pDiscoveryOptions = {
    listenPort: number;
    logger?: {
        info: (message: string) => void;
        warn: (message: string) => void;
        error: (message: string) => void;
        debug?: (message: string) => void;
    };
    onDiscoveredWsAddress: (address: string) => Promise<void>;
};
export declare class Libp2pDiscovery extends EventEmitter {
    private readonly options;
    private node;
    private started;
    constructor(options: Libp2pDiscoveryOptions);
    start(): Promise<void>;
    stop(): Promise<void>;
}
