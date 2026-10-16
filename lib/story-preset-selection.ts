import type { PresetConfig, Prompt } from "./settings-types";

export function isStoryPresetPromptEnabled(preset: PresetConfig, prompt: Prompt): boolean {
  return preset.prompt_order?.find(entry => entry.identifier === prompt.identifier)?.enabled ?? prompt.enabled;
}

/** Local story choices override textual entries, never mutate the shared preset or its markers. */
export function selectStoryPresetPrompts(preset: PresetConfig | null, selectedIds?: string[]): PresetConfig | null {
  if (!preset || selectedIds === undefined) return preset;
  const allowed = new Set(selectedIds);
  const textualIds = new Set(preset.prompts.filter(prompt => !prompt.marker).map(prompt => prompt.identifier));
  return {
    ...preset,
    prompts: preset.prompts.map(prompt => prompt.marker ? prompt : { ...prompt, enabled: allowed.has(prompt.identifier) }),
    prompt_order: preset.prompt_order?.map(entry => textualIds.has(entry.identifier)
      ? { ...entry, enabled: allowed.has(entry.identifier) } : entry),
  };
}
