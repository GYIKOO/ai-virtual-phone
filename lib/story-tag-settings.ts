/** Display folding and context exclusion are separate settings. */
export const DEFAULT_STORY_FOLD_TAGS = "think,thinking,summary,story_status,story_theater";
export const DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS = "think,thinking,story_theater";
export const LEGACY_STORY_FOLD_TAGS = "think,thinking,story_status,story_theater";
export const STORY_FOLD_TAGS_VERSION = 1;

export function storyFoldSignature(regexSignature: string, foldTags?: string): string {
  return `${regexSignature}|fold:${JSON.stringify(foldTags?.trim() ?? DEFAULT_STORY_FOLD_TAGS)}`;
}
