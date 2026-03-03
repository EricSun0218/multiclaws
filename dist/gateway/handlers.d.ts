import type { GatewayRequestHandler } from "../types/openclaw";
import type { MulticlawsService } from "../service/multiclaws-service";
export declare function createGatewayHandlers(getService: () => MulticlawsService): Record<string, GatewayRequestHandler>;
