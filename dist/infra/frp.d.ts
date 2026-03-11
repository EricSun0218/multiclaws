export type FrpTunnelConfig = {
    serverAddr: string;
    serverPort: number;
    token: string;
    portRangeStart: number;
    portRangeEnd: number;
};
export type FrpTunnelStatus = {
    status: "running";
    publicUrl: string;
    remotePort: number;
} | {
    status: "starting";
} | {
    status: "stopped";
} | {
    status: "error";
    reason: string;
};
type Logger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
};
/** Check if frpc binary is available in system PATH */
export declare function detectFrpc(): boolean;
export declare class FrpTunnelManager {
    private readonly config;
    private readonly localPort;
    private readonly stateDir;
    private readonly logger;
    private frpcProcess;
    private healthCheckTimer;
    private _status;
    private _publicUrl;
    private configPath;
    private adminPort;
    constructor(opts: {
        config: FrpTunnelConfig;
        localPort: number;
        stateDir: string;
        logger?: Logger;
    });
    get status(): FrpTunnelStatus;
    get publicUrl(): string | null;
    start(): Promise<string>;
    stop(): Promise<void>;
    private tryStartWithPort;
    private waitForProxy;
    private startHealthCheck;
    private killProcess;
    private ensureFrpcBinary;
    private downloadFrpc;
}
export {};
