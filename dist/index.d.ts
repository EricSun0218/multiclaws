import type { OpenClawPluginApi } from "./types/openclaw";
declare const plugin: {
    id: string;
    name: string;
    version: string;
    register(api: OpenClawPluginApi): void;
};
export default plugin;
