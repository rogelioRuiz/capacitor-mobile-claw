import { join, normalize, sep } from "node:path";
export const getTypeScriptPackageJsonPath = (dirname = "") => {
    let nodeModulesPath;
    const normalizedPath = normalize(dirname);
    const parts = normalizedPath.split(sep);
    const nodeModulesIndex = parts.indexOf("node_modules");
    if (nodeModulesIndex !== -1) {
        nodeModulesPath = parts.slice(0, nodeModulesIndex).join(sep);
    }
    else {
        nodeModulesPath = dirname;
    }
    return join(nodeModulesPath, "node_modules", "typescript", "package.json");
};
