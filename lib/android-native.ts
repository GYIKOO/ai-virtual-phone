type NativeClient = {
    permissionGranted: boolean;
    request(op: string, args?: Record<string, unknown>): Promise<unknown>;
    downloadBlob(blob: Blob, name: string): Promise<void>;
};

export function getAndroidNative(): NativeClient | undefined {
    if (typeof window === "undefined") return undefined;
    return (window as Window & { FloatNativeClient?: NativeClient }).FloatNativeClient;
}
