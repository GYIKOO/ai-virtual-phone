import type { PresetConfig } from "./settings-types";

export type PresetStreamingMode = "auto" | "stream" | "non-stream";
type StreamingPreset = Pick<PresetConfig, "streaming_mode"> | null | undefined;

export function isPresetStreamingMode(value: unknown): value is PresetStreamingMode {
    return value === "auto" || value === "stream" || value === "non-stream";
}

/** Old presets retain their application's choice until the user selects a mode. */
export function usePresetStreaming(preset: StreamingPreset, applicationDefault: boolean): boolean {
    return isPresetStreamingMode(preset?.streaming_mode)
        ? preset.streaming_mode !== "non-stream"
        : applicationDefault;
}

/** Only explicit protocol rejection can safely retry; never network/empty/partial output. */
export function isStreamingUnsupported(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    return /^API (?:Tool )?Stream Error (?:400|404|405|415|422|501):/i.test(message)
        && /(?:stream(?:ing)?|SSE|event-stream)[\s\S]{0,100}(?:not supported|unsupported|not allowed|disabled|not available)|(?:not supported|unsupported|not allowed|does not support)[\s\S]{0,100}(?:stream(?:ing)?|SSE|event-stream)|不支持.{0,20}流式/i.test(message);
}

export async function requestWithPresetStreaming<T>(
    preset: StreamingPreset,
    applicationDefault: boolean,
    stream: () => Promise<T>,
    complete: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    if (!usePresetStreaming(preset, applicationDefault)) return complete();
    try {
        return await stream();
    } catch (error) {
        if (preset?.streaming_mode === "stream" || signal?.aborted || !isStreamingUnsupported(error)) throw error;
        return complete();
    }
}
