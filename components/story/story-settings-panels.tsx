"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// Device-only navigation preferences: deliberately separate from story/settings exports.
export const STORY_PANEL_STORAGE_KEY = "float-story-settings-panels-v1";
const DEFAULT_OPEN: Record<string, boolean> = { presets: false, schemes: false, general: false, extra: false,
  generation: true, voice: false, font: false, reading: false, input: false, tail: false, phone: false, advanced: false };
const GROUPS = [
  { label: "预设与生成", id: "generation" },
  { label: "阅读与外观", id: "reading" },
  { label: "辅助与高级", id: "advanced" },
] as const;
type SettingsTab = typeof GROUPS[number]["id"];
const TAB_STORAGE_KEY = "float-story-settings-tab-v1";
type OpenPanels = Record<string, boolean>;
type PanelsContext = { opened: OpenPanels; setOpen: (id: string, open: boolean) => void; activeTab: SettingsTab };
const Panels = createContext<PanelsContext | null>(null);
const defaultOpen = (id: string) => DEFAULT_OPEN[id] ?? true;
const panelDomId = (id: string) => `story-settings-panel-${id}`;

function readOpenPanels(): OpenPanels {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORY_PANEL_STORAGE_KEY) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, open]) => typeof open === "boolean"));
  } catch { return {}; }
}

export function StorySettingsPanels({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<OpenPanels>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>("generation");
  const navigation = useRef<HTMLElement | null>(null);
  const current = useRef(opened);
  useEffect(() => {
    const sync = () => { current.current = readOpenPanels(); setOpened(current.current); };
    sync();
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
      const group = GROUPS.find(item => item.id === saved);
      if (group) setActiveTab(group.id);
    } catch { /* The first tab remains available when storage is blocked. */ }
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORY_PANEL_STORAGE_KEY || event.key === null) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const setOpen = (id: string, open: boolean) => {
    if ((current.current[id] ?? defaultOpen(id)) === open) return;
    const next = { ...current.current, [id]: open };
    current.current = next;
    setOpened(next);
    try { window.localStorage.setItem(STORY_PANEL_STORAGE_KEY, JSON.stringify(next)); } catch { /* UI still works without storage. */ }
  };
  const selectTab = (id: SettingsTab) => {
    if (id === activeTab) return;
    setActiveTab(id);
    try { window.localStorage.setItem(TAB_STORAGE_KEY, id); } catch { /* Selection still works. */ }
    const scroll = navigation.current?.nextElementSibling;
    if (scroll instanceof HTMLElement) scroll.scrollTop = 0;
  };
  return <Panels.Provider value={{ opened, setOpen, activeTab }}>
    <nav ref={navigation} className="story-settings-shortcuts" role="tablist" aria-label="剧情设置分类">
      {GROUPS.map((group, index) => <button type="button" key={group.id} role="tab"
        id={`story-settings-tab-${group.id}`} aria-controls={`story-settings-page-${group.id}`}
        aria-selected={activeTab === group.id} tabIndex={activeTab === group.id ? 0 : -1}
        onClick={() => selectTab(group.id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % GROUPS.length
            : event.key === "ArrowLeft" ? (index + GROUPS.length - 1) % GROUPS.length
            : event.key === "Home" ? 0 : event.key === "End" ? GROUPS.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          selectTab(GROUPS[next].id);
          navigation.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}>{group.label}</button>)}
    </nav>
    {children}
  </Panels.Provider>;
}

/** Hide inactive pages without unmounting editors or dropping uncommitted input. */
export function StorySettingsTabPage({ tab, children }: { tab: SettingsTab; children: ReactNode }) {
  const panels = useContext(Panels);
  return <div role="tabpanel" id={`story-settings-page-${tab}`} aria-labelledby={`story-settings-tab-${tab}`}
    className="story-settings-tab-page" hidden={Boolean(panels && panels.activeTab !== tab)}>
    {children}
  </div>;
}

export function SettingCard({ title, hint, children, sectionId, summary }: {
  title: string; hint?: string; children: ReactNode; sectionId?: string; summary?: string;
}) {
  const panels = useContext(Panels);
  // Future upstream cards without navigation metadata remain fully visible.
  if (!sectionId || !panels) return <section className="story-settings-card">
    <div className="story-settings-card-head"><h2>{title}</h2>{hint ? <p>{hint}</p> : null}</div>
    {children}
  </section>;
  const open = panels.opened[sectionId] ?? defaultOpen(sectionId);
  return <details id={panelDomId(sectionId)} className="story-settings-card story-settings-disclosure" open={open}>
    <summary className="story-settings-card-head" onClick={event => {
      // Persist user actions only: mount/programmatic toggle events must not overwrite restored state.
      event.preventDefault();
      panels.setOpen(sectionId, !open);
    }}>
      <span className="story-settings-card-title" role="heading" aria-level={2}>{title}</span>
      <ChevronDown size={16} className="story-settings-card-chevron" aria-hidden="true" />
      {summary ? <span className="story-settings-card-summary">{summary}</span> : null}
    </summary>
    <div className="story-settings-card-body">
      {hint ? <p className="story-settings-note">{hint}</p> : null}
      {children}
    </div>
  </details>;
}
