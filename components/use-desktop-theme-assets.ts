"use client";

import { useEffect, useRef, useState } from "react";
import { collectDesktopThemeAssetIds, getThemeAssetMap, subscribeThemeAssetChanges } from "@/lib/theme-storage";
import type { ThemeProfile } from "@/lib/theme-types";

export function useDesktopThemeAssets(profile: ThemeProfile, initial?: Record<string, string>) {
  const [assets, setAssets] = useState<Record<string, string>>(() => initial ?? {});
  const cached = useRef(assets);
  const epoch = useRef(0);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify(collectDesktopThemeAssetIds(profile).sort());

  useEffect(() => {
    const activeIds = new Set<string>(JSON.parse(key));
    const invalidate = (ids?: string[]) => {
      if (ids && !ids.some(id => activeIds.has(id) || cached.current[id])) return;
      const next = { ...cached.current };
      for (const id of ids ?? Object.keys(next)) delete next[id];
      cached.current = next;
      epoch.current++;
      // Keep the currently displayed assets until revalidation completes.
      // Clearing state on focus would briefly remove wallpaper and fonts.
      setRevision(value => value + 1);
    };
    // Refocus also revalidates after another tab or a backup restore changed IDB.
    const onFocus = () => invalidate();
    const unsubscribe = subscribeThemeAssetChanges(invalidate);
    window.addEventListener("focus", onFocus);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", onFocus);
    };
  }, [key]);

  useEffect(() => {
    const ids = (JSON.parse(key) as string[]).filter(id => !cached.current[id]);
    if (!ids.length) return;
    let disposed = false;
    const startedAt = epoch.current;
    void getThemeAssetMap(ids, { requireDatabase: true }).then(map => {
      if (disposed || epoch.current !== startedAt) return;
      // Only successful, still-current reads enter the cache. StrictMode's
      // cancelled first pass must not claim assets that it never published.
      cached.current = { ...cached.current, ...map };
      setAssets(cached.current);
    }).catch(error => console.warn("[Desktop] theme asset load failed:", error));
    return () => { disposed = true; };
  }, [key, revision]);

  return assets;
}
