import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const configPath = path.join(root, "wxt.config.ts");
const config = readFileSync(configPath, "utf8");

const versionField = /version:\s*"[^"]+"/;
if (!versionField.test(config)) {
    console.error("sync-version: couldn't find a `version` field in wxt.config.ts");
    process.exit(1);
}

writeFileSync(configPath, config.replace(versionField, `version: "${pkg.version}"`));
console.log(`sync-version: wxt.config.ts -> ${pkg.version}`);
