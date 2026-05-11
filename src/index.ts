import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { init  as permissionGateInit } from "./permission-gate";

export default function (pi: ExtensionAPI) {
    permissionGateInit(pi);
}