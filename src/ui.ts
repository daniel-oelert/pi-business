/**
 * Centralized UI handling for the pi-business extension.
 *
 * All user-facing prompts, selections, and interactions are managed here
 * so that future additions to the extension can extend this module.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BashPermissionRequestedEvent, BashPermissionResponseEvent } from "./types";
import { BASH_PERMISSION_REQUESTED, BASH_PERMISSION_RESPONSE } from "./types";

export function initUI(pi: ExtensionAPI) {
	let activeCtx: ExtensionContext | null = null;

	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
	});

	pi.on("turn_start", (_event, ctx) => {
		activeCtx = ctx;
	});

	// Sequential chain so concurrent permission requests are handled one at a time.
	// Without this, parallel bash tool calls would race on ui.select() — one dialog
	// would replace the other, and the losing request would time out after 5 minutes.
	let uiChain: Promise<void> = Promise.resolve();

	pi.events.on(BASH_PERMISSION_REQUESTED, (data) => {
		const request = data as BashPermissionRequestedEvent;

		uiChain = uiChain.then(async () => {
			if (activeCtx && activeCtx.hasUI) {
				try {
					const choice = await activeCtx.ui.select(
						`Bash command requested:\n\n  ${request.command}\n\nAllow?`,
						["Yes", "No"]
					);
					pi.events.emit(BASH_PERMISSION_RESPONSE, {
						requestId: request.requestId,
						allowed: choice === "Yes",
						reason: choice !== "Yes" ? "Blocked by user" : undefined,
					} satisfies BashPermissionResponseEvent);
				} catch (error) {
					pi.events.emit(BASH_PERMISSION_RESPONSE, {
						requestId: request.requestId,
						allowed: false,
						reason: "UI Error: " + ((error as Error).message ?? "Unknown error"),
					} satisfies BashPermissionResponseEvent);
				}
			}
		});
	});
}
