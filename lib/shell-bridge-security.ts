"use client";

import { isKvHydrated } from "./kv-db";
import { loadDeviceActionConfig, TOGGLEABLE_ACTIONS } from "./device-action/storage";
import { loadPerceptionConfig } from "./perception/storage";
import { loadScreenshotConfig } from "./screenshot/config";
import { loadCheckInConfig } from "./screenshot/checkin-config";
import { loadSystemCalendarConfig } from "./system-calendar/config";
import { loadWidgetConfig } from "./widget/storage";

/** Read the existing settings; no new defaults or persisted permission source. */
export function buildNativeBridgePolicy(): Record<string, unknown> {
  if (!isKvHydrated()) return {};
  const device = loadDeviceActionConfig();
  const perception = loadPerceptionConfig();
  const screenshot = loadScreenshotConfig();
  const calendar = loadSystemCalendarConfig();
  const capabilities = ["battery", "network", "foregroundApp", "steps", "usageStats", "location", "sleep"] as const;
  return {
    actions: Object.fromEntries(TOGGLEABLE_ACTIONS.map(id => [id, device.enabled && device.actions[id] === true])),
    perception: Object.fromEntries(capabilities.map(id => [id, perception.enabled && perception.capabilities[id] !== false])),
    screenshot: screenshot.enabled,
    screenshotBall: screenshot.enabled && screenshot.ballEnabled,
    checkIns: Object.fromEntries(Object.entries(loadCheckInConfig()).map(([id, config]) => [id, config.enabled])),
    calendarRead: calendar.readEnabled,
    calendarWrite: calendar.writeEnabled,
    widget: loadWidgetConfig().enabled,
  };
}

export function syncNativeBridgePolicy(): void {
  if (typeof window === "undefined" || window !== window.top) return;
  const security = (window as Window & { FloatShellSecurity?: { configure(policy: Record<string, unknown>): void } }).FloatShellSecurity;
  if (!security) return;
  try { security.configure(buildNativeBridgePolicy()); }
  catch (error) { console.warn("[ShellBridge] Permission sync unavailable", error); }
}

export function installNativeBridgePolicySync(): () => void {
  if (typeof window === "undefined") return () => {};
  const events = ["float-shell-ready", "device-action-config-changed", "perception-config-changed",
    "screenshot-config-changed", "check-in-config-changed", "system-calendar-config-changed", "phone-widget-updated"];
  for (const event of events) window.addEventListener(event, syncNativeBridgePolicy);
  syncNativeBridgePolicy();
  return () => { for (const event of events) window.removeEventListener(event, syncNativeBridgePolicy); };
}
