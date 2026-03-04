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

function multiaddrToWs(addr: string): string | null {
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

export class Libp2pDiscovery extends EventEmitter {
  private node: unknown | null = null;
  private started = false;

  constructor(private readonly options: Libp2pDiscoveryOptions) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    const [{ createLibp2p }, { webSockets }, { tcp }, { noise }, { yamux }, { mdns }] = await Promise.all([
      import("libp2p"),
      import("@libp2p/websockets"),
      import("@libp2p/tcp"),
      import("@chainsafe/libp2p-noise"),
      import("@libp2p/yamux"),
      import("@libp2p/mdns"),
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

    const handler = async (event: unknown) => {
      const detail = (event as { detail?: unknown })?.detail;
      const multiaddrs = (detail as { multiaddrs?: Array<{ toString(): string }> })?.multiaddrs ?? [];
      for (const ma of multiaddrs) {
        const wsAddress = multiaddrToWs(ma.toString());
        if (!wsAddress) {
          continue;
        }
        try {
          await this.options.onDiscoveredWsAddress(wsAddress);
        } catch (error) {
          this.options.logger?.debug?.(
            `[multiclaws][libp2p] failed to process discovered address ${wsAddress}: ${String(error)}`,
          );
        }
      }
    };

    (node as { addEventListener?: (name: string, handler: (event: unknown) => void | Promise<void>) => void }).addEventListener?.(
      "peer:discovery",
      handler,
    );

    await (node as { start(): Promise<void> }).start();
    this.node = node;
    this.started = true;
    this.options.logger?.info(`[multiclaws][libp2p] discovery started on tcp/${this.options.listenPort}/ws`);
  }

  async stop(): Promise<void> {
    if (!this.started || !this.node) {
      return;
    }
    try {
      await (this.node as { stop(): Promise<void> }).stop();
    } finally {
      this.started = false;
      this.node = null;
    }
  }
}
