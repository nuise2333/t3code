import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const THOUGHT_TRANSLATION_MAX_TEXT_LENGTH = 32_000;

export const ThoughtTranslationStyle = Schema.Literals(["technical", "concise"]);
export type ThoughtTranslationStyle = typeof ThoughtTranslationStyle.Type;

export const ThoughtTranslationInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(THOUGHT_TRANSLATION_MAX_TEXT_LENGTH)),
  targetLanguage: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  style: Schema.optionalKey(ThoughtTranslationStyle),
});
export type ThoughtTranslationInput = typeof ThoughtTranslationInput.Type;

export const ThoughtTranslationResult = Schema.Struct({
  translatedText: Schema.String,
  cached: Schema.Boolean,
  skipped: Schema.Boolean,
});
export type ThoughtTranslationResult = typeof ThoughtTranslationResult.Type;

export const ThoughtTranslationErrorReason = Schema.Literals([
  "generation_failed",
  "empty_output",
  "settings_unavailable",
]);
export type ThoughtTranslationErrorReason = typeof ThoughtTranslationErrorReason.Type;

export class ThoughtTranslationError extends Schema.TaggedError<ThoughtTranslationError>()(
  "ThoughtTranslationError",
  {
    reason: ThoughtTranslationErrorReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "settings_unavailable":
        return "Could not read text generation settings for thought translation.";
      case "empty_output":
        return "The model returned an empty thought translation.";
      case "generation_failed":
        return "Thought translation failed.";
    }
  }
}
