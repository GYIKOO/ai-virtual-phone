"use client";

import { useEffect } from "react";
import { hydrateKvDb } from "@/lib/kv-db";
import { isShellEnvironment, markAccountPushSubscribed } from "@/lib/push-client";
import { reconcileShellPersonalPush } from "@/lib/shell-personal-push";

export function ShellPushController() {
    useEffect(() => {
        if (!isShellEnvironment()) return;
        let disposed = false;
        const sync = async () => {
            await hydrateKvDb();
            if (disposed) return;
            // Local bridge checks only: no periodic cloud/API requests or silent subscription.
            try {
                if (!await reconcileShellPersonalPush()) markAccountPushSubscribed(false);
            } catch { /* Old APK reports an actionable error when the user enables push. */ }
        };
        const refresh = () => { void sync(); };
        window.addEventListener("float-personal-cloud-changed", refresh);
        window.addEventListener("float-native-permission", refresh);
        document.addEventListener("visibilitychange", refresh);
        refresh();
        return () => {
            disposed = true;
            window.removeEventListener("float-personal-cloud-changed", refresh);
            window.removeEventListener("float-native-permission", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, []);
    return null;
}
