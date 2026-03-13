"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLUGIN_VERSION = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
function readPackageVersion() {
    try {
        const pkgPath = node_path_1.default.resolve(__dirname, "..", "..", "package.json");
        const pkg = JSON.parse(node_fs_1.default.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "0.0.0";
    }
    catch {
        return "0.0.0";
    }
}
exports.PLUGIN_VERSION = readPackageVersion();
