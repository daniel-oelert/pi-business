/**
 * Centralized UI handling for the pi-business extension.
 *
 * All user-facing prompts, selections, and interactions are managed here
 * so that future additions to the extension can extend this module.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  BashPermissionRequestedEvent,
  BashPermissionResponseEvent,
  QuestionRequestedEvent,
  QuestionResponseEvent,
} from "./types";
import {
  BASH_PERMISSION_REQUESTED,
  BASH_PERMISSION_RESPONSE,
  QUESTION_REQUESTED,
  QUESTION_RESPONSE,
} from "./types";

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

	pi.events.on(QUESTION_REQUESTED, (data) => {
		const request = data as QuestionRequestedEvent;

		uiChain = uiChain.then(async () => {
			if (activeCtx && activeCtx.hasUI) {
				try {
					const choices = [...request.options];
					if (request.allowCustomAnswer) {
						choices.push("Other (type my own answer)");
					}

					const choice = await activeCtx.ui.select(
						request.question,
						choices
					);

					if (choice === undefined) {
						// User cancelled (esc or timed out)
						pi.events.emit(QUESTION_RESPONSE, {
							requestId: request.requestId,
							answer: null,
							cancelled: true,
						} satisfies QuestionResponseEvent);
						return;
					}

					if (choice === "Other (type my own answer)") {
						const customAnswer = await activeCtx.ui.input(
							"Type your answer:",
							"Your custom answer…"
						);
						if (customAnswer === undefined || customAnswer.trim() === "") {
							pi.events.emit(QUESTION_RESPONSE, {
								requestId: request.requestId,
								answer: null,
								cancelled: true,
							} satisfies QuestionResponseEvent);
						} else {
							pi.events.emit(QUESTION_RESPONSE, {
								requestId: request.requestId,
								answer: customAnswer.trim(),
								cancelled: false,
							} satisfies QuestionResponseEvent);
						}
					} else {
						pi.events.emit(QUESTION_RESPONSE, {
							requestId: request.requestId,
							answer: choice,
							cancelled: false,
						} satisfies QuestionResponseEvent);
					}
				} catch (error) {
					pi.events.emit(QUESTION_RESPONSE, {
						requestId: request.requestId,
						answer: null,
						cancelled: true,
					} satisfies QuestionResponseEvent);
				}
			} else {
				// No UI available (headless / print mode)
				pi.events.emit(QUESTION_RESPONSE, {
					requestId: request.requestId,
					answer: null,
					cancelled: true,
				} satisfies QuestionResponseEvent);
			}
		});
	});
}
