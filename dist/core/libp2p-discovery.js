"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.Libp2pDiscovery = void 0;
const node_events_1 = require("node:events");
function multiaddrToWs(addr) {
    const ipv4 = addr.match(/^\/ip4\/([^/]+)\/tcp\/(\d+)\/ws(?:\/|$)/);
    if (ipv4) {
        return `ws://${ipv4[1]}:${ipv4[2]}`;
    }
    const ipv6 = addr.match(/^\/ip6\/([^/]+)\/tcp\/(\d+)\/ws(?:\/|$)/);
    if (ipv6) {
        return `ws://[${ipv6[1]}]:${ipv6[2]}`;
    }
    return null;
}
class Libp2pDiscovery extends node_events_1.EventEmitter {
    options;
    node = null;
    started = false;
    constructor(options) {
        super();
        this.options = options;
    }
    async start() {
        if (this.started) {
            return;
        }
        const [{ createLibp2p }, { webSockets }, { tcp }, { noise }, { yamux }, { mdns }] = await Promise.all([
            Promise.resolve().then(() => __importStar(require("libp2p"))),
            Promise.resolve().then(() => __importStar(require("@libp2p/websockets"))),
            Promise.resolve().then(() => __importStar(require("@libp2p/tcp"))),
            Promise.resolve().then(() => __importStar(require("@chainsafe/libp2p-noise"))),
            Promise.resolve().then(() => __importStar(require("@libp2p/yamux"))),
            Promise.resolve().then(() => __importStar(require("@libp2p/mdns"))),
        ]);
        const node = await createLibp2p({
            addresses: {
                listen: [`/ip4/0.0.0.0/tcp/${this.options.listenPort}/ws`],
            },
            transports: [tcp(), webSockets()],
            connectionEncrypters: [noise()],
            streamMuxers: [yamux()],
            peerDiscovery: [
                mdns({
                    interval: 20_000,
                    serviceTag: "multiclaws-mdns",
                }),
            ],
        });
        const handler = async (event) => {
            const detail = event?.detail;
            const multiaddrs = detail?.multiaddrs ?? [];
            for (const ma of multiaddrs) {
                const wsAddress = multiaddrToWs(ma.toString());
                if (!wsAddress) {
                    continue;
                }
                try {
                    await this.options.onDiscoveredWsAddress(wsAddress);
                }
                catch (error) {
                    this.options.logger?.debug?.(`[multiclaws][libp2p] failed to process discovered address ${wsAddress}: ${String(error)}`);
                }
            }
        };
        node.addEventListener?.("peer:discovery", handler);
        await node.start();
        this.node = node;
        this.started = true;
        this.options.logger?.info(`[multiclaws][libp2p] discovery started on tcp/${this.options.listenPort}/ws`);
    }
    async stop() {
        if (!this.started || !this.node) {
            return;
        }
        try {
            await this.node.stop();
        }
        finally {
            this.started = false;
            this.node = null;
        }
    }
}
exports.Libp2pDiscovery = Libp2pDiscovery;
