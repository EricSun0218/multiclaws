"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileStore = void 0;
exports.renderProfileDescription = renderProfileDescription;
const json_store_1 = require("../infra/json-store");
function emptyProfile() {
    return { ownerName: "", bio: "" };
}
function renderProfileDescription(profile) {
    const parts = [];
    if (profile.ownerName)
        parts.push(profile.ownerName);
    if (profile.bio)
        parts.push(profile.bio);
    return parts.join("\n\n") || "OpenClaw agent";
}
class ProfileStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        const raw = await (0, json_store_1.readJsonWithFallback)(this.filePath, {});
        // Migrate legacy profile format (role/description/dataSources/capabilities → bio)
        if (typeof raw.bio !== "string") {
            const parts = [];
            if (typeof raw.role === "string" && raw.role)
                parts.push(`**Role:** ${raw.role}`);
            if (typeof raw.description === "string" && raw.description)
                parts.push(raw.description);
            if (Array.isArray(raw.capabilities) && raw.capabilities.length > 0) {
                const caps = raw.capabilities
                    .map((c) => (c.description ? `- ${c.tag}: ${c.description}` : `- ${c.tag}`))
                    .join("\n");
                parts.push(`**Capabilities:**\n${caps}`);
            }
            if (Array.isArray(raw.dataSources) && raw.dataSources.length > 0) {
                const sources = raw.dataSources
                    .map((s) => (s.description ? `- ${s.name}: ${s.description}` : `- ${s.name}`))
                    .join("\n");
                parts.push(`**Data Sources:**\n${sources}`);
            }
            raw.bio = parts.join("\n\n");
        }
        return {
            ownerName: typeof raw.ownerName === "string" ? raw.ownerName : "",
            bio: typeof raw.bio === "string" ? raw.bio : "",
        };
    }
    async save(profile) {
        await (0, json_store_1.writeJsonAtomically)(this.filePath, profile);
    }
    async update(patch) {
        const profile = await this.load();
        if (patch.ownerName !== undefined)
            profile.ownerName = patch.ownerName;
        if (patch.bio !== undefined)
            profile.bio = patch.bio;
        await this.save(profile);
        return profile;
    }
}
exports.ProfileStore = ProfileStore;
