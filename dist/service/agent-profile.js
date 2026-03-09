"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileStore = void 0;
exports.renderProfileDescription = renderProfileDescription;
const json_store_1 = require("../infra/json-store");
function emptyProfile() {
    return { ownerName: "", role: "", dataSources: [], capabilities: [] };
}
function renderProfileDescription(profile) {
    const parts = [];
    if (profile.ownerName && profile.role) {
        parts.push(`${profile.ownerName}, ${profile.role}`);
    }
    else if (profile.ownerName) {
        parts.push(profile.ownerName);
    }
    else if (profile.role) {
        parts.push(profile.role);
    }
    if (profile.description) {
        parts.push(profile.description);
    }
    const caps = profile.capabilities ?? [];
    if (caps.length > 0) {
        const capStr = caps
            .map((c) => (c.description ? `${c.tag} (${c.description})` : c.tag))
            .join(", ");
        parts.push(`capabilities: ${capStr}`);
    }
    if (profile.dataSources.length > 0) {
        const sources = profile.dataSources
            .map((s) => (s.description ? `${s.name} (${s.description})` : s.name))
            .join(", ");
        parts.push(`data sources: ${sources}`);
    }
    return parts.join(". ") || "OpenClaw agent";
}
class ProfileStore {
    filePath;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        const raw = await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyProfile());
        if (!Array.isArray(raw.capabilities))
            raw.capabilities = [];
        return raw;
    }
    async save(profile) {
        await (0, json_store_1.writeJsonAtomically)(this.filePath, profile);
    }
    async update(patch) {
        const profile = await this.load();
        if (patch.ownerName !== undefined)
            profile.ownerName = patch.ownerName;
        if (patch.role !== undefined)
            profile.role = patch.role;
        if (patch.description !== undefined)
            profile.description = patch.description;
        await this.save(profile);
        return profile;
    }
    async addDataSource(source) {
        const profile = await this.load();
        const idx = profile.dataSources.findIndex((s) => s.name.toLowerCase() === source.name.toLowerCase());
        if (idx >= 0) {
            profile.dataSources[idx] = source;
        }
        else {
            profile.dataSources.push(source);
        }
        await this.save(profile);
        return profile;
    }
    async removeDataSource(name) {
        const profile = await this.load();
        profile.dataSources = profile.dataSources.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
        await this.save(profile);
        return profile;
    }
    async addCapability(cap) {
        const profile = await this.load();
        if (!profile.capabilities)
            profile.capabilities = [];
        const tagLower = cap.tag.toLowerCase();
        const idx = profile.capabilities.findIndex((c) => c.tag.toLowerCase() === tagLower);
        if (idx >= 0) {
            profile.capabilities[idx] = cap;
        }
        else {
            profile.capabilities.push(cap);
        }
        await this.save(profile);
        return profile;
    }
    async removeCapability(tag) {
        const profile = await this.load();
        if (!profile.capabilities)
            profile.capabilities = [];
        profile.capabilities = profile.capabilities.filter((c) => c.tag.toLowerCase() !== tag.toLowerCase());
        await this.save(profile);
        return profile;
    }
}
exports.ProfileStore = ProfileStore;
