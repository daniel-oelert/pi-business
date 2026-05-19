import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { init as permissionGateInit } from "./src/permission-gate";
import { initSubagentTool } from "./src/subagent-tool";
import { initModelAliases } from "./src/model-aliases";

export default function (pi: ExtensionAPI) {
    const skillsDir = join(dirname(fileURLToPath(import.meta.url)), "skills");

    pi.on("resources_discover", async (event, _ctx) => {
    return {
        skillPaths: [skillsDir],
        promptPaths: [],
        themePaths: [],
    };
    });
    
    initModelAliases(pi);
    permissionGateInit(pi);
    initSubagentTool(pi);
}
