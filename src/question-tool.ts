/**
 * Question Tool — Lets the agent ask the user multiple-choice questions
 * with an optional custom-answer input.
 *
 * Uses the event-bus pattern (like permission-gate) so questions from
 * subagents bubble up to the main agent's UI.
 *
 * Architecture:
 *   question-tool.ts                ui.ts
 *   ────────────────                ──────
 *   execute()                        pi.events.on(QUESTION_REQUESTED)
 *     │                                │
 *     ├─ emit REQUEST ────────────────►│
 *     │                                ├─ uiChain.then(...)
 *     │                                │  └─ ctx.ui.select(options + "Other…")
 *     │                                │     └─ if "Other…": ctx.ui.input()
 *     │                                │        └─ emit RESPONSE
 *     │◄───────────────────────────────┘
 *     │
 *     └─ resolve({ content, details })
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  QuestionRequestedEvent,
  QuestionResponseEvent,
} from "./types";
import {
  QUESTION_REQUESTED,
  QUESTION_RESPONSE,
} from "./types";

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  return `question-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/** Details stored on the tool result for rendering and state tracking. */
export interface QuestionToolDetails {
  question: string;
  options: string[];
  answer: string | null;
  cancelled: boolean;
  wasCustom?: boolean;
  timedOut?: boolean;
}

// ── Parameter schema ────────────────────────────────────────────────────────

const QuestionParams = Type.Object({
  question: Type.String({
    description: "The question to ask the user",
  }),
  options: Type.Array(Type.String(), {
    description:
      "Available options to present to the user. The user can also type a custom answer if allowCustomAnswer is true.",
  }),
  allowCustomAnswer: Type.Optional(
    Type.Boolean({
      description:
        "Whether the user can type a custom answer instead of selecting an option. Default: true.",
    }),
  ),
});

export interface QuestionParamsInput {
  question: string;
  options: string[];
  allowCustomAnswer?: boolean;
}

// ── Tool definition (raw — for subagent customTools) ────────────────────────

/**
 * Returns a raw tool definition that subagents can use via `customTools`.
 * The returned object is NOT registered on the extension API — it is meant
 * to be passed directly to `createAgentSession({ customTools: [...] })`.
 */
export function createQuestionToolDef(pi: ExtensionAPI) {
  return {
    name: "question",
    label: "Question",
    description:
      "Ask the user a multiple choice question with the option to type their own answer. " +
      "Use when you need user input to proceed — e.g. clarifying requirements, " +
      "confirming decisions, or getting preferences.",
    promptSnippet: "Ask the user to pick from options or type a custom answer",
    parameters: QuestionParams,

    async execute(
      _toolCallId: string,
      params: QuestionParamsInput,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ): Promise<any> {
      const requestId = generateRequestId();
      const allowCustomAnswer = params.allowCustomAnswer !== false;
      const options: string[] = Array.isArray(params.options) ? params.options : [];

      if (options.length === 0) {
        throw new Error("At least one option is required.");
      }

      pi.events.emit(QUESTION_REQUESTED, {
        requestId,
        question: params.question,
        options,
        allowCustomAnswer,
      } satisfies QuestionRequestedEvent);

      return new Promise((resolve, reject) => {
        const unsub = pi.events.on(QUESTION_RESPONSE, (data) => {
          const response = data as QuestionResponseEvent;
          if (response.requestId !== requestId) return;

          unsub();
          clearTimeout(timer);

          if (response.cancelled || response.answer === null) {
            resolve({
              content: [{ type: "text", text: "User cancelled the question." }],
              details: {
                question: params.question,
                options,
                answer: null,
                cancelled: true,
              } satisfies QuestionToolDetails,
            });
          } else {
            resolve({
              content: [{ type: "text", text: `Answer: ${response.answer}` }],
              details: {
                question: params.question,
                options,
                answer: response.answer,
                cancelled: false,
                wasCustom: !options.includes(response.answer) && allowCustomAnswer,
              } satisfies QuestionToolDetails,
            });
          }
        });

        // Timeout after 5 minutes — reject so the agent sees an error
        const timer = setTimeout(() => {
          unsub();
          reject(new Error("Question timed out after 5 minutes."));
        }, 5 * 60 * 1000);
      });
    },

    renderCall(args: unknown, theme: any, _context: unknown) {
      const a = args as QuestionParamsInput | undefined;
      const q = a?.question || "...";
      const preview = q.length > 60 ? `${q.slice(0, 60)}...` : q;
      let text =
        theme.fg("toolTitle", theme.bold("question ")) +
        theme.fg("accent", preview);
      const opts: string[] = Array.isArray(a?.options) ? a.options : [];
      if (opts.length > 0) {
        const labels = opts
          .slice(0, 4)
          .map((o: string, i: number) => `${i + 1}. ${o}`)
          .join(", ");
        const more = opts.length > 4 ? ` +${opts.length - 4} more` : "";
        text += `\n  ${theme.fg("dim", `Options: ${labels}${more}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result: unknown, _options: unknown, theme: any, _context: unknown) {
      const r = result as { details?: QuestionToolDetails; content?: Array<{ type?: string; text?: string }> } | undefined;
      const details = r?.details;

      if (!details) {
        const fallback = r?.content?.[0];
        return new Text(
          fallback?.type === "text" ? fallback.text : "(no output)",
          0,
          0,
        );
      }

      if (details.timedOut) {
        return new Text(theme.fg("warning", "⏱ Timed out (5 min)"), 0, 0);
      }

      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const answer = details.answer;
      const idx = details.options ? details.options.indexOf(answer) + 1 : 0;
      const display = details.wasCustom
        ? `${theme.fg("muted", "(wrote) ")}${theme.fg("accent", answer)}`
        : idx > 0
          ? `${idx}. ${theme.fg("accent", answer)}`
          : theme.fg("accent", answer);

      return new Text(`${theme.fg("success", "✓ ")}${display}`, 0, 0);
    },
  };
}

// ── Extension registration ──────────────────────────────────────────────────

/** Register the question tool on the main agent's extension API. */
export function initQuestionTool(pi: ExtensionAPI) {
  pi.registerTool(createQuestionToolDef(pi));
}
