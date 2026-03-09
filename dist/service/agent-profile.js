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
        return await (0, json_store_1.readJsonWithFallback)(this.filePath, emptyProfile());
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
