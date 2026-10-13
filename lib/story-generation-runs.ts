import { loadStoryMessages, loadStorySessions } from "./story-storage";

type StoryGenerationRun = { runId: string; controller: AbortController; history: string };
const activeStoryGenerationRuns = new Map<string, StoryGenerationRun>();
const listeners = new Set<() => void>();
const historySignature = (sessionId: string) => JSON.stringify(loadStoryMessages(sessionId).map(m => [m.id, m.role, m.rawContent, m.kind]));
function notify() { for (const listener of listeners) listener(); }

export function getGeneratingStorySessionIds(): ReadonlySet<string> {
  return new Set(activeStoryGenerationRuns.keys());
}
export function subscribeStoryGeneration(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function createStoryGenerationRun(sessionId: string): StoryGenerationRun {
  activeStoryGenerationRuns.get(sessionId)?.controller.abort();
  const run = { runId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, controller: new AbortController(), history: historySignature(sessionId) };
  activeStoryGenerationRuns.set(sessionId, run);
  notify();
  return run;
}
export function isStoryGenerationRunActive(sessionId: string, runId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  const session = loadStorySessions().find(item => item.id === sessionId);
  return Boolean(run && run.runId === runId && !run.controller.signal.aborted && session && !session.mergedIntoSessionId
    && run.history === historySignature(sessionId));
}
export function finishStoryGenerationRun(sessionId: string, runId: string): boolean {
  if (activeStoryGenerationRuns.get(sessionId)?.runId !== runId) return false;
  activeStoryGenerationRuns.delete(sessionId);
  notify();
  return true;
}
export function cancelStoryGenerationRun(sessionId: string): boolean {
  const run = activeStoryGenerationRuns.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  activeStoryGenerationRuns.delete(sessionId);
  notify();
  return true;
}
