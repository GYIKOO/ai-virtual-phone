import { getAndroidNative } from "./android-native";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";

type ShellPushStatus = { deviceId: string; url: string; configured: boolean; connected: boolean; permission: boolean };

export async function shellPushStatus(): Promise<ShellPushStatus> {
    const native = getAndroidNative();
    if (!native) throw new Error("请安装支持个人云推送的新版 APK。");
    try {
        const value = await native.request("personalPushStatus") as ShellPushStatus;
        if (!value || typeof value.deviceId !== "string") throw new Error("invalid status");
        return value;
    } catch {
        throw new Error("当前 APK 尚不支持个人云推送，请更新 APK 后重试。");
    }
}

export async function connectShellPersonalPush(): Promise<void> {
    if (!isPersonalPushCloudActive()) throw new Error("请先在设置 → 云服务部署中部署个人离线推送。");
    const status = await shellPushStatus();
    const native = getAndroidNative()!;
    if (!await native.request("requestPermission")) throw new Error("请先允许 APK 的系统通知权限。");
    const projectUrl = loadPersonalPushCloudState()!.url;
    const response = await personalPushFetch("shell-subscribe", {
        method: "POST", body: JSON.stringify({ deviceId: status.deviceId }),
    });
    const result = await response.json().catch(() => ({})) as {
        ok?: boolean; error?: string; config?: { url: string; anonKey: string; channelId: string };
    };
    if (!response.ok || !result.ok || !result.config) {
        throw new Error(response.status === 404 ? "个人云尚不支持 APK 推送，请重新部署离线推送函数。" : result.error || "个人云尚不支持 APK 推送，请重新部署离线推送函数。");
    }
    if (!isPersonalPushCloudActive() || loadPersonalPushCloudState()?.url !== projectUrl || result.config.url !== projectUrl) {
        throw new Error("个人云项目已变更，请重新开启推送。");
    }
    await native.request("configurePersonalPush", { config: result.config });
}

export async function disconnectShellPersonalPush(): Promise<void> {
    const status = await shellPushStatus();
    // Stop local delivery even if the remote service is unavailable. Never delete other devices.
    await getAndroidNative()!.request("configurePersonalPush", { config: null });
    if (isPersonalPushCloudActive() && status.url === loadPersonalPushCloudState()?.url) {
        const response = await personalPushFetch("subscribe", {
            method: "DELETE", body: JSON.stringify({ endpoint: `shell:device:${status.deviceId}` }),
        });
        const result = await response.json().catch(() => ({})) as { ok?: boolean };
        if (!response.ok || !result.ok) throw new Error("本机接收已关闭，但云端退订失败，请联网后重试关闭。");
    }
}

/** No network or automatic subscription: disconnect stale projects after restore/config changes. */
export async function reconcileShellPersonalPush(): Promise<boolean> {
    const status = await shellPushStatus();
    if (status.configured && (!isPersonalPushCloudActive() || status.url !== loadPersonalPushCloudState()?.url)) {
        await getAndroidNative()!.request("configurePersonalPush", { config: null });
        return false;
    }
    return status.configured && status.permission;
}
