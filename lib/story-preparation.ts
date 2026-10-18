export type StoryGenerationPhase = "preparing" | "recalling" | "requesting";

export function throwIfStoryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("剧情生成已停止");
  error.name = "AbortError";
  throw error;
}

/** Give React a paint opportunity before CPU work; the timer also works in background tabs. */
export async function yieldStoryPreparation(signal?: AbortSignal): Promise<void> {
  throwIfStoryAborted(signal);
  if (typeof window === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    let frame: number | undefined;
    let afterFrame: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(fallback);
      if (afterFrame !== undefined) clearTimeout(afterFrame);
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => { cleanup(); resolve(); };
    const abort = () => {
      cleanup();
      try { throwIfStoryAborted(signal); } catch (error) { reject(error); }
    };
    const fallback = setTimeout(finish, 40);
    signal?.addEventListener("abort", abort, { once: true });
    if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(() => { afterFrame = setTimeout(finish, 0); });
  });
  throwIfStoryAborted(signal);
}

/** Shared by multi-member preparation; small jobs need not wait a frame per member. */
export function createPromptPreparationCheckpoint(signal?: AbortSignal): () => Promise<void> {
  const clock = () => typeof performance === "undefined" ? Date.now() : performance.now();
  let lastYield = -Infinity;
  return async () => {
    throwIfStoryAborted(signal);
    if (clock() - lastYield < 8) return;
    await yieldStoryPreparation(signal);
    lastYield = clock();
  };
}
