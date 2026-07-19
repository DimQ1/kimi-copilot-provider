/**
 * Minimal typings for the `chatProvider` proposed API used by Copilot Chat
 * to surface per-model configuration such as the "Thinking Effort" picker.
 *
 * This file is intentionally small: we only declare the pieces we consume so
 * the extension can compile against stable `@types/vscode` while still using
 * the proposed fields at runtime.
 *
 * Also includes `LanguageModelThinkingPart` (proposed API) which lets
 * LanguageModelChatProviders emit thinking/reasoning content that VS Code
 * renders in a collapsible "thinking" section in the Chat UI.
 */

declare module 'vscode' {
	export interface LanguageModelChatInformation {
		/**
		 * A numeric value for comparing model cost tiers.
		 */
		readonly multiplierNumeric?: number;

		/**
		 * Whether this model is a "bring your own key" (BYOK) model.
		 */
		readonly isBYOK?: boolean;

		/**
		 * Whether or not the model will show up in the model picker immediately.
		 */
		readonly isUserSelectable?: boolean;

		readonly statusIcon?: ThemeIcon;

		/**
		 * An optional JSON schema describing the configuration options for this model.
		 */
		configurationSchema?: LanguageModelConfigurationSchema;

		/**
		 * Optional warning text to display in the model picker hover.
		 */
		readonly warningText?: Record<string, string>;

		/**
		 * Optional promotional information for this model.
		 */
		readonly promo?: {
			readonly id: string;
			readonly discountPercent: number;
			readonly endsAt: string;
			readonly message: string;
		};

		readonly inputCost?: string;
		readonly outputCost?: string;
		readonly cacheCost?: string;
		readonly priceCategory?: string;
	}

	export type LanguageModelConfigurationSchema = {
		readonly properties?: {
			readonly [key: string]: Record<string, unknown> & {
				readonly enumItemLabels?: string[];
				readonly group?: string;
			};
		};
	};

	export interface ProvideLanguageModelChatResponseOptions {
		/**
		 * Per-model configuration provided by the user.
		 */
		readonly modelConfiguration?: {
			readonly [key: string]: unknown;
		};
	}

	// ─── LanguageModelThinkingPart (proposed API) ──────────────────────

	/**
	 * A language model response part containing thinking/reasoning content.
	 * Thinking tokens represent the model's internal reasoning process that
	 * typically streams before the final response.
	 *
	 * This is a proposed API — if unavailable at runtime the provider will
	 * fall back to prepending thinking as regular text.
	 */
	export class LanguageModelThinkingPart {
		/**
		 * The thinking/reasoning text content.
		 */
		value: string | string[];

		/**
		 * Optional unique identifier for this thinking sequence.
		 */
		id?: string;

		/**
		 * Optional metadata associated with this thinking sequence.
		 */
		metadata?: { readonly [key: string]: any };

		/**
		 * Construct a thinking part with the given content.
		 * @param value The thinking text content.
		 * @param id Optional unique identifier for this thinking sequence.
		 * @param metadata Optional metadata associated with this thinking sequence.
		 */
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
	}
}
