import type { GatewayRequestHandler } from "../types/openclaw";
import type { MulticlawsService } from "../service/multiclaws-service";
import type { BasicLogger } from "../infra/logger";
export declare function createGatewayHandlers(getService: () => MulticlawsService, logger?: BasicLogger): Record<string, GatewayRequestHandler>;
