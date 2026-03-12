"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileStore = void 0;
exports.renderProfileDescription = renderProfileDescription;
exports.formatAgentCardName = formatAgentCardName;
const json_store_1 = require("../infra/json-store");
function emptyProfile() {
    return { ownerName: "", bio: "" };
}
function renderProfileDescription(profile) {
    return profile.bio?.trim() || "OpenClaw agent";
}
function formatAgentCardName(ownerName) {
    return `${ownerName} 的 OpenClaw`;
}
class ProfileStore {
    filePath;
    logger;
    constructor(filePath, logger) {
        this.filePath = filePath;
        this.logger = logger;
    }
    log(level, message) {
        const fn = level === "debug" ? this.logger?.debug : this.logger?.[level];
        fn?.(`[profile-store] ${message}`);
    }
    async load() {
        return await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyProfile());
    }
    async save(profile) {
        this.log("debug", `save(ownerName=${profile.ownerName})`);
        try {
            await (0, json_store_1.writeJsonAtomically)(this.filePath, profile);
        }
        catch (err) {
            this.log("error", `save failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async update(patch) {
        this.log("debug", `update(keys=${Object.keys(patch).join(",")})`);
        try {
            const profile = await this.load();
            if (patch.ownerName !== undefined)
                profile.ownerName = patch.ownerName;
            if (patch.bio !== undefined)
                profile.bio = patch.bio;
            await this.save(profile);
            this.log("debug", `update completed`);
            return profile;
        }
        catch (err) {
            this.log("error", `update failed: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
}
exports.ProfileStore = ProfileStore;
