/**
 * Permission Gate Extension
 *
 * Prompts for confirmation before running potentially dangerous bash commands.
 * Patterns checked: rm -rf, sudo, chmod/chown 777
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { initUI } from "./ui";
import type { BashPermissionRequestedEvent, BashPermissionResponseEvent} from "./types";
import { BASH_PERMISSION_REQUESTED, BASH_PERMISSION_RESPONSE } from "./types";



// Helper function to generate random IDs
function generateRequestId(): string {
	return `bash-permission-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function init(pi: ExtensionAPI) {
	// Initialize centralized UI handling
	initUI(pi);

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const requestId = generateRequestId();

		// Emit event so other parts of the extension (or subagents) can handle the UI
		pi.events.emit(BASH_PERMISSION_REQUESTED, { requestId, command } satisfies BashPermissionRequestedEvent);

		// Wait for the response event, whichever side emitted it
		return new Promise((resolve) => {
			const unsub = pi.events.on(BASH_PERMISSION_RESPONSE, (data) => {
				const response = data as BashPermissionResponseEvent;
				if (response.requestId !== requestId) return;

				unsub();
				clearTimeout(timer);

				if (response.allowed) {
					resolve(undefined);
				} else {
					resolve({ block: true, reason: response.reason ?? "Blocked by permission system" });
				}
			});

			// Timeout after 5 minutes
			const timer = setTimeout(() => {
				unsub();
				resolve({ block: true, reason: "Permission request timed out" });
			}, 5 * 60 * 1000);
		});
	});

}