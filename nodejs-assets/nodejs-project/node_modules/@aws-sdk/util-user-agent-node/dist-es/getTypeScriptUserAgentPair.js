import { readFile } from "node:fs/promises";
import { getTypeScriptPackageJsonPath } from "./getTypeScriptPackageJsonPath";
let tscVersion;
export const getTypeScriptUserAgentPair = async () => {
    if (tscVersion === null) {
        return undefined;
    }
    else if (typeof tscVersion === "string") {
        return ["md/tsc", tscVersion];
    }
    try {
        const packageJson = await readFile(getTypeScriptPackageJsonPath(__dirname), "utf-8");
        const { version } = JSON.parse(packageJson);
        if (typeof version !== "string") {
            tscVersion = null;
            return undefined;
        }
        tscVersion = version;
        return ["md/tsc", tscVersion];
    }
    catch {
        tscVersion = null;
    }
};
