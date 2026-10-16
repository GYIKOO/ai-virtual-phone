"use client";
import { DEFAULT_STORY_FOLD_TAGS, DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS } from "@/lib/story-tag-settings";
import { createStoryGenerationRun, isStoryGenerationRunActive, finishStoryGenerationRun, cancelStoryGenerationRun, getGeneratingStorySessionIds, subscribeStoryGeneration } from "@/lib/story-generation-runs";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  BookOpenIcon,
  PaintBrushIcon,
  PaperAirplaneIcon,
  PlusIcon,
  StopIcon,
  XMarkIcon,
} from "@heroicons/react/24/solid";

/* 三条粗横条的实心菜单图标，与实心图标集的笔画粗细一致 */
function SolidMenuIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="3" y="4.6" width="18" height="2.8" />
      <rect x="3" y="10.6" width="18" height="2.8" />
      <rect x="3" y="16.6" width="18" height="2.8" />
    </svg>
  );
}

/* 粗笔画「‹」返回图标，笔画粗细与菜单横条一致 */
function SolidBackIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 5 L8 12 L15 19"
        stroke="currentColor"
        strokeWidth={2.8}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function MiniPhoneIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 5h4M10.7 18.6h2.6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { Avatar } from "@/components/ui/primitives";
import { StoryHtmlRenderer, type StoryVoiceSegment } from "@/components/ui/story-html-renderer";
import { StorySettingsPage, STORY_DEFAULT_STATUS_RENDER, STORY_DEFAULT_THEATER_RENDER } from "@/components/story/story-settings-page";
import { loadCharacters } from "@/lib/character-storage";
import { maybeRunSummarization } from "@/lib/memory-summarizer";
import { incrementEventCounter } from "@/lib/memory-storage";
import { loadBindingConfig, loadPresets, resolveBinding, resolveUserIdentity } from "@/lib/settings-storage";
import {
  generateStoryCompletion,
  getStoryRenderSignature,
  rebuildStorySessionRenderCache,
} from "@/lib/story-engine";
import {
  createOrGetStorySession,
  createStoryGroup,
  deleteStoryGroup,
  deleteStorySessions,
  getStorySessionOwnerKey,
  hydrateStoryStorage,
  loadStoryGroups,
  loadStoryGlobalSettings,
  loadStoryMessages,
  mergeStoryPageIntoMain,
  loadStorySessions,
  loadStorySessionsForOwner,
  loadStorySchemeRepository,
  pushStoryMessage,
  resolveActiveQuickInputScheme,
  saveStorySchemeRepository,
  saveStoryGlobalSettings,
  STORY_DEFAULT_QUICK_INPUT_OPTIONS,
  STORY_SCHEME_REPO_EVENT,
  STORY_GLOBAL_SETTINGS_EVENT,
  deleteStoryMessage,
  deleteStoryMessagesFrom,
  editStoryMessage,
  type StoryMessage,
  type StorySchemeRepository,
  type StorySession,
  updateStorySession,
  updateStoryGroup,
  type StoryCharacterSettings,
  type StoryGlobalSettings,
  type StoryGroup,
  type StoryOwnerType,
} from "@/lib/story-storage";
import { createOrGetSession, hydrateChatStorage, loadChatMessages, loadChatSessions, markChatSessionRead, pushChatMessage } from "@/lib/chat-storage";
import { flattenCompletionResult, generateChatCompletion } from "@/lib/chat-engine";
import { cancelBackgroundGeneration } from "@/lib/follow-up-service";
import { generateGroupChatCompletion } from "@/lib/group-chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { MomentsFeed } from "@/components/chat/moments-feed";
import { PhoneChatApp } from "@/components/chat/phone-chat-app";
import { GiftPickerModal } from "@/components/chat/gift-picker-modal";
import { TransferTargetModal } from "@/components/chat/transfer-target-modal";
import { LocationInputModal, PhotoInputModal, RedPacketModal, VoiceRecordModal } from "@/components/chat/rich-input-modals";
import { STORY_CSS_EXAMPLE } from "@/lib/css-examples";
import { applyEditOutputRegex } from "@/lib/llm-prompt-assembler";
import { MacroEngine } from "@/lib/macro-engine";
import { getStoryRetryContext } from "@/lib/story-instructions";
import { StoryActions, StoryDirectorNote, type StoryActionRequest } from "./story-actions";
import { replaceStoryMessages } from "@/lib/story-storage";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { downloadFile } from "@/lib/download-utils";
import { loadDeliveredShoppingGifts, type ShoppingGiftCandidate } from "@/lib/shopping-gift-utils";
import { payWithWalletBalance } from "@/lib/wallet-storage";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import type { MomentPost } from "@/lib/moments-types";
import {
  playAudioBlobViaMediaElement,
  resolveVoiceConfig,
  synthesizeSpeech,
  unlockAudioPlayback,
} from "@/lib/tts-service";

type StoryAppProps = {
  onClose: () => void;
};

const storyVoiceCache = new Map<string, Blob>();
const STORY_VOICE_CACHE_LIMIT = 24;
const STORY_ACTIVE_CHARACTER_KEY = "story-last-active-character-id";
const STORY_ACTIVE_TARGET_KEY = "story-last-active-target-v1";
const STORY_ACTIVE_PAGE_MAP_KEY = "story-active-page-map-v1";
const DEFAULT_AUTO_READING_SPEED = 36;

registerKvMigration(STORY_ACTIVE_CHARACTER_KEY);
registerKvMigration(STORY_ACTIVE_TARGET_KEY);
registerKvMigration(STORY_ACTIVE_PAGE_MAP_KEY);

type StoryActiveTarget = { ownerType: StoryOwnerType; ownerId: string };
type FloatingPhoneTab = "chat" | "moments";
type FloatingRichKind = "voice" | "image" | "transfer_target" | "transfer" | "location" | "gift" | null;

function escapeStoryTraceHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] || char);
}

function loadStoryActivePageMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(kvGet(STORY_ACTIVE_PAGE_MAP_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function saveStoryActivePage(ownerKey: string, sessionId: string): void {
  kvSet(STORY_ACTIVE_PAGE_MAP_KEY, JSON.stringify({ ...loadStoryActivePageMap(), [ownerKey]: sessionId }));
}

function loadStoryActiveTarget(): StoryActiveTarget | null {
  try {
    const parsed = JSON.parse(kvGet(STORY_ACTIVE_TARGET_KEY) || "null") as StoryActiveTarget | null;
    if (!parsed || (parsed.ownerType !== "single" && parsed.ownerType !== "group") || !parsed.ownerId) return null;
    return parsed;
  } catch {
    return null;
  }
}

function cacheStoryVoice(key: string, blob: Blob) {
  if (storyVoiceCache.has(key)) storyVoiceCache.delete(key);
  storyVoiceCache.set(key, blob);
  while (storyVoiceCache.size > STORY_VOICE_CACHE_LIMIT) {
    const oldest = storyVoiceCache.keys().next().value;
    if (!oldest) break;
    storyVoiceCache.delete(oldest);
  }
}

function isAbortLikeError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) return error.name === "AbortError" || /aborted|abort/i.test(error.message);
  return false;
}

function formatStoryTime(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const CSS_EXAMPLE = STORY_CSS_EXAMPLE;
const STORY_THEMES = [
  { id: "paper", color: "#94a3b8", name: "纸白" },
  { id: "warm", color: "#b89870", name: "手账" },
  { id: "night", color: "#3a4560", name: "夜读" },
  { id: "ink", color: "#1a1a1a", name: "水墨" },
  { id: "rose", color: "#d4889a", name: "玫瑰" },
  { id: "sage", color: "#7a9a6a", name: "青苔" },
] as const;

function getStoryPreview(messages: StoryMessage[]): string {
  const last = messages[messages.length - 1];
  if (!last) return "从这里开始新的剧情。";
  if (last.kind === "director") return "导演指令";
  const source = last.renderedContent || last.rawContent || "";
  // Strip HTML tags and collapse whitespace for preview text
  const text = source.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 60) || "继续上次的场景。";
}

function resizeStoryComposerTextarea(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

type StoryComposerAppendRequest = {
  id: number;
  text: string;
};

const STORY_GENERATION_STATUS = ["整理场景", "续写剧情", "打磨对白", "写入故事"];
const STORY_INITIAL_LOAD = 10;
const STORY_LOAD_MORE_COUNT = 10;

function StoryGeneratingIndicator({
  characterName,
  avatar,
}: {
  characterName: string;
  avatar?: string;
}) {
  const [statusIndex, setStatusIndex] = useState(0);
  const status = STORY_GENERATION_STATUS[statusIndex % STORY_GENERATION_STATUS.length];

  useEffect(() => {
    const timer = window.setInterval(() => {
      setStatusIndex((index) => (index + 1) % STORY_GENERATION_STATUS.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <article className="story-row" data-role="assistant">
      <div className="story-msg-head">
        <div className="story-avatar-wrap">
          <Avatar src={avatar || undefined} name={characterName} size="md" />
        </div>
        <div className="story-msg-meta">
          <span className="story-msg-name">{characterName}</span>
          <span className="story-msg-time story-generating-head">{status}</span>
        </div>
      </div>
      <div className="story-bubble-wrap">
        <div className="story-bubble story-generating-bubble" aria-label="正在生成剧情">
          <span className="story-generating-copy">{status}</span>
          <span className="story-generating-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      </div>
    </article>
  );
}

const StoryComposer = memo(function StoryComposer({
  isGenerating,
  appendRequest,
  voiceEnabled,
  voicePlaying,
  voiceProgress,
  onSend,
  onContinue,
  autoReadingEnabled,
  autoReading,
  currentReadExpanded,
  canAutoRead,
  onToggleAutoReading,
  onCurrentReadControl,
  onStop,
  tools,
  onPlayNext,
  quickInputEnabled,
  quickInputOptions,
  quickInputCursor,
}: {
  isGenerating: boolean;
  appendRequest: StoryComposerAppendRequest | null;
  voiceEnabled: boolean;
  voicePlaying: boolean;
  voiceProgress: { current: number; total: number };
  onSend: (text: string) => void;
  onContinue: () => void;
  autoReadingEnabled: boolean;
  autoReading: boolean;
  currentReadExpanded: boolean;
  canAutoRead: boolean;
  onToggleAutoReading: () => void;
  onCurrentReadControl: () => void;
  onStop: () => void;
  tools?: React.ReactNode;
  onPlayNext: () => void;
  quickInputEnabled: boolean;
  quickInputOptions: string[];
  quickInputCursor: "left" | "middle" | "right";
}) {
  const [draft, setDraft] = useState("");
  const [quickPanelOpen, setQuickPanelOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastAppendIdRef = useRef<number | null>(null);
  // 记录输入框最近一次选区/光标：点快捷选项时按钮会抢走焦点，
  // 这时 selectionStart 已经不可靠，用这个 ref 兜底
  const lastSelectionRef = useRef<{ start: number; end: number } | null>(null);

  const rememberSelection = (el: HTMLTextAreaElement) => {
    lastSelectionRef.current = { start: el.selectionStart, end: el.selectionEnd };
  };

  const insertQuickOption = (option: string) => {
    const sel = lastSelectionRef.current;
    const start = Math.min(sel ? sel.start : draft.length, draft.length);
    const end = Math.max(start, Math.min(sel ? sel.end : draft.length, draft.length));
    const nextDraft = draft.slice(0, start) + option + draft.slice(end);
    // 光标落点：左边=插入内容之前；中间=成对符号正中（单字符视作末尾）；右边=插入内容之后
    const caretOffset = quickInputCursor === "left"
      ? 0
      : quickInputCursor === "right"
        ? option.length
        : Math.ceil(option.length / 2);
    const caret = start + caretOffset;
    setDraft(nextDraft);
    lastSelectionRef.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(caret, caret);
    });
  };

  useEffect(() => {
    if (!appendRequest || appendRequest.id === lastAppendIdRef.current) return;
    lastAppendIdRef.current = appendRequest.id;
    setDraft(prev => prev + appendRequest.text);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      resizeStoryComposerTextarea(textarea);
      textarea.focus();
    });
  }, [appendRequest]);

  const submit = () => {
    if (isGenerating) {
      onStop();
      return;
    }
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) resizeStoryComposerTextarea(textarea);
    });
    onSend(text);
  };

  return (
    <div className="story-composer" data-quick-input={quickInputEnabled ? "true" : undefined}>
      {tools}
      {quickInputEnabled && quickPanelOpen && quickInputOptions.length > 0 ? (
        <div className="story-quick-panel" role="toolbar" aria-label="快捷输入面板">
          {quickInputOptions.map((option, index) => (
            <button
              key={`${index}-${option}`}
              type="button"
              className="story-quick-chip"
              onClick={() => insertQuickOption(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        className="story-sequence-play"
        data-enabled={voiceEnabled ? "true" : undefined}
        data-playing={voicePlaying ? "true" : undefined}
        onClick={onPlayNext}
        disabled={voicePlaying}
        aria-label="播放下一句角色对白"
        title="播放下一句"
      >
        <span aria-hidden="true">{voicePlaying ? "…" : "▶"}</span>
        {voiceProgress.total > 0 ? (
          <small>{voiceProgress.current}/{voiceProgress.total}</small>
        ) : null}
      </button>
      <button
        type="button"
        className="story-continue-btn"
        onClick={onContinue}
        disabled={isGenerating}
      >
        续写
      </button>
      {quickInputEnabled ? (
        <button
          type="button"
          className="story-quick-input-btn"
          data-open={quickPanelOpen ? "true" : undefined}
          onClick={() => setQuickPanelOpen((open) => !open)}
          aria-expanded={quickPanelOpen}
          aria-label={quickPanelOpen ? "收起快捷输入面板" : "展开快捷输入面板"}
        >
          输入
        </button>
      ) : null}
      {autoReadingEnabled ? (
        <>
          <button
            type="button"
            className="story-auto-read-btn"
            data-reading={autoReading ? "true" : undefined}
            onClick={onToggleAutoReading}
            disabled={!autoReading && !canAutoRead}
            aria-label={autoReading ? "停止自动阅读" : "从最新角色消息开始自动阅读"}
          >
            {autoReading ? "停止" : "自动"}
          </button>
          <button
            type="button"
            className="story-current-read-btn"
            data-expanded={currentReadExpanded ? "true" : undefined}
            onClick={onCurrentReadControl}
            disabled={!canAutoRead}
            aria-label={currentReadExpanded ? "从当前位置开始自动阅读" : "展开当前位置阅读按钮"}
            title="从当前位置开始阅读"
          >
            <BookOpenIcon width={14} height={14} aria-hidden="true" />
            {currentReadExpanded ? <span>从当前位置开始阅读</span> : null}
          </button>
        </>
      ) : null}
      <textarea
        ref={textareaRef}
        rows={1}
        value={draft}
        onFocus={(event) => { resizeStoryComposerTextarea(event.currentTarget); rememberSelection(event.currentTarget); }}
        onSelect={(event) => rememberSelection(event.currentTarget)}
        onKeyUp={(event) => rememberSelection(event.currentTarget)}
        onChange={(event) => {
          setDraft(event.target.value);
          rememberSelection(event.currentTarget);
          resizeStoryComposerTextarea(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="你该怎么回应"
      />
      <button
        className={`story-send-btn${isGenerating ? " is-generating" : ""}`}
        onClick={submit}
        aria-label={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        title={isGenerating ? "停止剧情生成" : "发送剧情输入"}
        disabled={!isGenerating && !draft.trim()}
      >
        {isGenerating ? <StopIcon width={17} height={17} /> : <PaperAirplaneIcon width={17} height={17} className="story-send-icon" />}
      </button>
    </div>
  );
});

export function StoryApp({ onClose }: StoryAppProps) {
  const [ready, setReady] = useState(false);
  const [, setStorageVersion] = useState(0);
  // 公用方案仓库版本：仓库内容变化（设置页/小卷工具写入）时刷新方案相关 UI
  const [schemeRepoVersion, setSchemeRepoVersion] = useState(0);
  const [storyGlobalSettings, setStoryGlobalSettings] = useState<StoryGlobalSettings>({ interruptProactiveDuringStory: false, streamingEnabled: false, timeAware: true });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [floatingPhoneOpen, setFloatingPhoneOpen] = useState(false);
  const [floatingPhoneTab, setFloatingPhoneTab] = useState<FloatingPhoneTab>("chat");
  const [floatingPlusOpen, setFloatingPlusOpen] = useState(false);
  const [floatingRichKind, setFloatingRichKind] = useState<FloatingRichKind>(null);
  const [floatingTransferTargetId, setFloatingTransferTargetId] = useState("");
  const [isolatedMomentDraft, setIsolatedMomentDraft] = useState("");
  const [isolatedMomentComposerOpen, setIsolatedMomentComposerOpen] = useState(false);
  const [floatingGroupSessionId, setFloatingGroupSessionId] = useState("");
  const [floatingChatDraft, setFloatingChatDraft] = useState("");
  const [floatingChatGenerating, setFloatingChatGenerating] = useState(false);
  const [floatingChatVersion, setFloatingChatVersion] = useState(0);
  const [activeCharacterId, setActiveCharacterId] = useState<string>("");
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [activeSessionId, setActiveSessionId] = useState<string>("");
  const [messages, setMessages] = useState<StoryMessage[]>([]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(STORY_INITIAL_LOAD);
  const [composerAppendRequest, setComposerAppendRequest] = useState<StoryComposerAppendRequest | null>(null);
  const [customCssDraft, setCustomCssDraft] = useState("");
  const [foldTagsDraft, setFoldTagsDraft] = useState("");
  const [contextExcludedTagsDraft, setContextExcludedTagsDraft] = useState("");
  // 生成状态按会话记录：避免在 A 会话生成时切到 B 会话也显示"正在生成"
  const [generatingSessionIds, setGeneratingSessionIds] = useState<ReadonlySet<string>>(getGeneratingStorySessionIds);
  const [mergingPage, setMergingPage] = useState(false);
  const mergingPageRef = useRef(false);
  const [streamingTextBySession, setStreamingTextBySession] = useState<Record<string, string>>({});
  const streamAccumulatorRef = useRef(new Map<string, string>());
  const streamPaintFrameRef = useRef(new Map<string, number>());
  // 抽屉滑动手势用 ref 而不是 state：手指按住时 touchmove 每帧都在触发，
  // 逐帧 setState 会让整个剧情页以事件频率重渲染（iOS 上拉到顶/底按住不动时
  // 表现为持续的重排/闪烁）
  const dragStartXRef = useRef<number | null>(null);
  const dragDeltaXRef = useRef(0);
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [actionRequest, setActionRequest] = useState<StoryActionRequest | null>(null);
  useEffect(() => { setActionRequest(null); }, [activeSessionId]);
  const [contextMenuPoint, setContextMenuPoint] = useState<{ x: number; y: number } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [cssModalOpen, setCssModalOpen] = useState(false);
  const [quickStoryOpen, setQuickStoryOpen] = useState(false);
  const [quickStoryIndependent, setQuickStoryIndependent] = useState(false);
  const [playingVoiceSegmentId, setPlayingVoiceSegmentId] = useState<string | null>(null);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [voiceSequenceProgress, setVoiceSequenceProgress] = useState({ current: 0, total: 0 });
  const [autoReading, setAutoReading] = useState(false);
  const [currentReadExpanded, setCurrentReadExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shellInnerRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef(true);
  const activeSessionIdRef = useRef("");
  const cacheRefreshKeyRef = useRef<string | null>(null);
  const composerAppendIdRef = useRef(0);
  const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  // ── 设置页往返的滚动位置恢复 ──
  // 设置页会整体卸载 story-stage（提前 return 渲染设置页），返回后是全新 DOM，
  // scrollTop 归零表现为"一进设置再回来就跳回顶部"。这里在 onScroll 里持续记录
  // 位置，返回时写回；设置期间切换角色或消息数量变化则放弃恢复、贴到底部。
  const stageScrollMemoRef = useRef(0);
  const settingsOpenSnapshotRef = useRef<{ sessionId: string; messageCount: number } | null>(null);
  const messagesLengthRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);
  const voicePlaybackRef = useRef<{ abort: () => void } | null>(null);
  const voiceRequestIdRef = useRef(0);
  const voiceNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceSequenceIndexRef = useRef(0);
  const miniPhoneScrollRef = useRef<HTMLDivElement | null>(null);
  const autoStartedSessionIdsRef = useRef(new Set<string>());

  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(
    () => resolveUserIdentity(activeCharacterId, "story") ?? resolveUserIdentity(activeCharacterId) ?? resolveUserIdentity(),
    [activeCharacterId]
  );
  const currentCharacter = useMemo(
    () => characters.find((character) => character.id === activeCharacterId) || null,
    [characters, activeCharacterId]
  );
  const sessions = loadStorySessions();
  const storyGroups: StoryGroup[] = loadStoryGroups();
  const activeGroup = storyGroups.find((group) => group.id === activeGroupId) || null;
  const activeGroupCharacters = activeGroup
    ? activeGroup.characterIds.map((id) => characters.find((character) => character.id === id)).filter(Boolean) as typeof characters
    : [];
  const activeOwnerType: StoryOwnerType = activeGroup ? "group" : "single";
  const activeOwnerId = activeGroup?.id || activeCharacterId;
  const ownerSessions = activeOwnerId ? loadStorySessionsForOwner(activeOwnerType, activeOwnerId) : [];
  const ownerMainSession = ownerSessions.find((session) => (session.branchId || "main") === "main") || ownerSessions[0] || null;
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const independentFloatingShell = currentSession?.independentStory === true;
  const storyDisplayName = activeGroup?.name || currentCharacter?.name || "剧情";
  const storyAvatar = ownerMainSession?.storyAvatar || currentCharacter?.avatar || "";
  const uiPrefs = currentSession?.uiPrefs || {};
  const customFontSource = uiPrefs.customFontDataUrl || uiPrefs.customFontUrl || "";
  const storyShellStyle = customFontSource
    ? ({ "--story-font": '"StoryCustomFont", "Noto Serif SC", "Songti SC", serif' } as CSSProperties)
    : undefined;
  const customFontFace = customFontSource
    ? `@font-face{font-family:"StoryCustomFont";src:url(${JSON.stringify(customFontSource)});font-display:swap;}`
    : "";
  const storySettings: StoryCharacterSettings = currentSession?.settings || {};
  // 方案定义统一来自公用仓库（所有角色共享），角色设置里只有“启用哪一个”
  const schemeRepo: StorySchemeRepository = useMemo(
    () => loadStorySchemeRepository(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [schemeRepoVersion, ready],
  );
  const activeStatusScheme = schemeRepo.statusSchemes.find((item) => item.id === storySettings.activeStatusSchemeId)
    ?? storySettings.statusSchemes?.find((item) => item.id === storySettings.activeStatusSchemeId);
  const activeTheaterScheme = schemeRepo.theaterSchemes.find((item) => item.id === storySettings.activeTheaterSchemeId)
    ?? storySettings.theaterSchemes?.find((item) => item.id === storySettings.activeTheaterSchemeId);
  const activeStatusRenderHtml = activeStatusScheme?.renderHtml
    ?? (["status-default", "status-html"].includes(activeStatusScheme?.id || "") ? STORY_DEFAULT_STATUS_RENDER : "");
  const activeTheaterRenderHtml = activeTheaterScheme?.renderHtml
    ?? (["theater-default", "theater-furry"].includes(activeTheaterScheme?.id || "") ? STORY_DEFAULT_THEATER_RENDER : "");
  const boundPreset = useMemo(() => {
    if (!activeCharacterId) return null;
    const slot = resolveBinding(loadBindingConfig(), activeCharacterId, "story");
    return (slot.presetId ? loadPresets().find((item) => item.id === slot.presetId) : null)
      || loadPresets().find((item) => item.builtIn)
      || null;
  }, [activeCharacterId]);
  const floatingGroupChatCandidates = useMemo(() => activeGroup && !independentFloatingShell
    ? loadChatSessions().filter((item) => item.isGroup)
    : [], [activeGroup, floatingChatVersion, independentFloatingShell]);
  const floatingChatSession = useMemo(() => {
    if (!activeCharacterId || independentFloatingShell) return null;
    if (activeGroup) {
      const selected = floatingGroupChatCandidates.find((item) => item.id === floatingGroupSessionId);
      if (selected) return selected;
      return floatingGroupChatCandidates.find((item) => activeGroup.characterIds.every((id) => item.participantIds?.includes(id))) || floatingGroupChatCandidates[0] || null;
    }
    return loadChatSessions().find((item) => item.contactId === activeCharacterId && !item.isGroup) || null;
  }, [activeCharacterId, activeGroup, floatingChatVersion, floatingGroupChatCandidates, floatingGroupSessionId, independentFloatingShell]);
  const floatingChatMessages = useMemo(() => floatingChatSession
    ? loadChatMessages(floatingChatSession.id).filter((item) => item.role === "user" || item.role === "assistant").slice(-30)
    : [], [floatingChatSession, floatingChatVersion]);
  const floatingChatContext = useMemo(() => floatingChatMessages.map((message) => {
    const name = message.role === "user" ? (userIdentity?.name || "用户") : (currentCharacter?.name || "角色");
    const text = message.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return `${new Date(message.createdAt).toLocaleString()} ${name}：${text}`;
  }).join("\n"), [currentCharacter?.name, floatingChatMessages, userIdentity?.name]);
  const floatingGiftCandidates = useMemo(
    () => loadDeliveredShoppingGifts({ includeSent: independentFloatingShell }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [floatingChatVersion, independentFloatingShell, floatingPhoneOpen],
  );
  const activeStreamingText = streamingTextBySession[activeSessionId] || "";
  const activeStoryParticipantKey = (currentSession?.participantIds?.length
    ? currentSession.participantIds
    : activeGroup?.characterIds?.length
      ? activeGroup.characterIds
      : [activeCharacterId]
  ).filter(Boolean).slice().sort().join("|");
  const isGenerating = Boolean(activeSessionId) && generatingSessionIds.has(activeSessionId);
  const isReadOnly = Boolean(currentSession?.mergedIntoSessionId || currentSession?.mergedIntoMainAt);
  const latestAssistantMessageId = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant")?.id || "",
    [messages],
  );
  const isolatedPhoneTraces = useMemo(
    () => messages.filter((message) => message.role === "system"
      && /^【剧情(?:小手机|朋友圈)/.test(message.rawContent)).slice(-20),
    [messages],
  );

  const markGenerating = useCallback((sessionId: string, on: boolean) => {
    if (!mountedRef.current) return;
    setGeneratingSessionIds((prev) => {
      if (on === prev.has(sessionId)) return prev;
      const next = new Set(prev);
      if (on) next.add(sessionId); else next.delete(sessionId);
      return next;
    });
  }, []);

  const refreshGenerationView = (sessionId: string) => {
    if (!mountedRef.current) return;
    if (activeSessionIdRef.current === sessionId) setMessages(loadStoryMessages(sessionId));
    setStorageVersion(value => value + 1);
  };

  useEffect(() => {
    const refresh = () => {
      setGeneratingSessionIds(getGeneratingStorySessionIds());
      if (activeSessionIdRef.current) setMessages(loadStoryMessages(activeSessionIdRef.current));
      setStorageVersion(value => value + 1);
    };
    refresh();
    return subscribeStoryGeneration(refresh);
  }, []);

  const appendStoryStreamDelta = useCallback((sessionId: string, delta: string) => {
    if (!mountedRef.current) return;
    streamAccumulatorRef.current.set(sessionId, (streamAccumulatorRef.current.get(sessionId) || "") + delta);
    if (streamPaintFrameRef.current.has(sessionId)) return;
    const frame = window.requestAnimationFrame(() => {
      streamPaintFrameRef.current.delete(sessionId);
      const nextText = streamAccumulatorRef.current.get(sessionId) || "";
      setStreamingTextBySession((prev) => ({ ...prev, [sessionId]: nextText }));
    });
    streamPaintFrameRef.current.set(sessionId, frame);
  }, []);

  const clearStoryStream = useCallback((sessionId: string) => {
    const frame = streamPaintFrameRef.current.get(sessionId);
    if (frame) window.cancelAnimationFrame(frame);
    streamPaintFrameRef.current.delete(sessionId);
    streamAccumulatorRef.current.delete(sessionId);
    if (!mountedRef.current) return;
    setStreamingTextBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);

  useEffect(() => {
    if (independentFloatingShell || !activeGroup) {
      setFloatingGroupSessionId("");
      return;
    }
    if (floatingGroupSessionId && floatingGroupChatCandidates.some((item) => item.id === floatingGroupSessionId)) return;
    const matching = floatingGroupChatCandidates.find((item) => activeGroup.characterIds.every((id) => item.participantIds?.includes(id)));
    setFloatingGroupSessionId(matching?.id || floatingGroupChatCandidates[0]?.id || "");
  }, [activeGroup?.id, floatingGroupChatCandidates, floatingGroupSessionId, independentFloatingShell]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
      for (const frame of streamPaintFrameRef.current.values()) window.cancelAnimationFrame(frame);
      streamPaintFrameRef.current.clear();
    };
  }, []);

  useEffect(() => {
    voiceSequenceIndexRef.current = 0;
    setVoiceSequenceProgress({ current: 0, total: 0 });
    voiceRequestIdRef.current += 1;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(null);
  }, [activeSessionId, latestAssistantMessageId]);

  useLayoutEffect(() => {
    if (!floatingPhoneOpen) return;
    const node = miniPhoneScrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [floatingChatGenerating, floatingChatVersion, floatingPhoneOpen]);

  function activateStorySession(session: StorySession) {
    setActiveSessionId(session.id);
    activeSessionIdRef.current = session.id;
    setVisibleMessageCount(STORY_INITIAL_LOAD);
    setMessages(loadStoryMessages(session.id));
    setCustomCssDraft(session.customCSS || "");
    setFoldTagsDraft(session.foldTags ?? DEFAULT_STORY_FOLD_TAGS);
    setContextExcludedTagsDraft(session.contextExcludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
    const ownerKey = getStorySessionOwnerKey(session);
    saveStoryActivePage(ownerKey, session.id);
    kvSet(STORY_ACTIVE_TARGET_KEY, JSON.stringify({ ownerType: session.ownerType || "single", ownerId: session.ownerId || session.characterId }));
    kvSet(STORY_ACTIVE_CHARACTER_KEY, session.characterId);
    setStorageVersion((value) => value + 1);
  }

  function resolveOwnerSession(ownerType: StoryOwnerType, ownerId: string, primaryCharacterId: string, participantIds?: string[]): StorySession {
    const main = createOrGetStorySession(primaryCharacterId, { ownerType, ownerId, participantIds, branchId: "main" });
    const rememberedId = loadStoryActivePageMap()[`${ownerType}:${ownerId}`];
    return loadStorySessionsForOwner(ownerType, ownerId).find((session) => session.id === rememberedId) || main;
  }

  useEffect(() => {
    hydrateStoryStorage().then(() => {
      const availableCharacters = loadCharacters();
      const groups = loadStoryGroups();
      const rememberedTarget = loadStoryActiveTarget();
      const rememberedCharacterId = kvGet(STORY_ACTIVE_CHARACTER_KEY) || kvGet("ai_phone_story_last_character") || "";
      const recentCharacterId = loadStorySessions()[0]?.characterId || "";
      const initialChar = availableCharacters.some((item) => item.id === rememberedCharacterId)
        ? rememberedCharacterId
        : availableCharacters.some((item) => item.id === recentCharacterId)
          ? recentCharacterId
          : availableCharacters[0]?.id || "";
      const rememberedGroup = rememberedTarget?.ownerType === "group"
        ? groups.find((group) => group.id === rememberedTarget.ownerId)
        : null;
      const groupPrimary = rememberedGroup?.characterIds.find((id) => availableCharacters.some((character) => character.id === id));
      if (rememberedGroup && groupPrimary) {
        setActiveGroupId(rememberedGroup.id);
        setActiveCharacterId(groupPrimary);
        activateStorySession(resolveOwnerSession("group", rememberedGroup.id, groupPrimary, rememberedGroup.characterIds));
      } else if (initialChar) {
        setActiveGroupId("");
        setActiveCharacterId(initialChar);
        activateStorySession(resolveOwnerSession("single", initialChar, initialChar, [initialChar]));
      }
      setStoryGlobalSettings(loadStoryGlobalSettings());
      setReady(true);
    });
  }, []);

  useEffect(() => {
    const syncGlobalSettings = () => setStoryGlobalSettings(loadStoryGlobalSettings());
    window.addEventListener(STORY_GLOBAL_SETTINGS_EVENT, syncGlobalSettings);
    return () => window.removeEventListener(STORY_GLOBAL_SETTINGS_EVENT, syncGlobalSettings);
  }, []);

  useEffect(() => {
    if (!ready || !storyGlobalSettings.interruptProactiveDuringStory || !activeStoryParticipantKey) return;
    const participantIds = new Set(activeStoryParticipantKey.split("|").filter(Boolean));
    const shouldInterrupt = (session: ChatSession) => session.isGroup
      ? Boolean(session.participantIds?.some((id) => participantIds.has(id)))
      : participantIds.has(session.contactId);
    const interruptSession = (sessionId: string) => {
      const session = loadChatSessions().find((item) => item.id === sessionId);
      if (session && shouldInterrupt(session)) cancelBackgroundGeneration(sessionId);
    };

    // 开关刚开启或切换见面对象时，也要截断已经在途的主动请求。
    loadChatSessions().filter(shouldInterrupt).forEach((session) => cancelBackgroundGeneration(session.id));
    const handleBackgroundStart = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) interruptSession(sessionId);
    };
    window.addEventListener("followup-started", handleBackgroundStart);
    return () => window.removeEventListener("followup-started", handleBackgroundStart);
  }, [activeStoryParticipantKey, ready, storyGlobalSettings.interruptProactiveDuringStory]);

  useEffect(() => {
    setAutoReading(false);
    setCurrentReadExpanded(false);
  }, [activeSessionId]);

  // Listen for live CSS updates from 小卷
  useEffect(() => {
    const onCSSUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId === activeSessionId) {
        setCustomCssDraft(detail.css || "");
      }
    };
    window.addEventListener("story-session-css-updated", onCSSUpdate);
    return () => window.removeEventListener("story-session-css-updated", onCSSUpdate);
  }, [activeSessionId]);

  // Listen for story tail scheme updates from 小卷 (剧情方案套件)
  useEffect(() => {
    const onSettingsUpdate = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId && detail.sessionId === activeSessionIdRef.current) {
        setStorageVersion((value) => value + 1);
      }
    };
    window.addEventListener("story-session-settings-updated", onSettingsUpdate);
    return () => window.removeEventListener("story-session-settings-updated", onSettingsUpdate);
  }, []);

  // Shared preferences may be edited through another page (e.g. 小卷 tools).
  useEffect(() => {
    const onOwnerSettingsUpdate = (event: Event) => {
      const session = loadStorySessions().find(item => item.id === activeSessionIdRef.current);
      if (!session || session.mergedIntoSessionId || session.mergedIntoMainAt
        || getStorySessionOwnerKey(session) !== (event as CustomEvent).detail?.ownerKey) return;
      setCustomCssDraft(session.customCSS || "");
      setFoldTagsDraft(session.foldTags ?? DEFAULT_STORY_FOLD_TAGS);
      setContextExcludedTagsDraft(session.contextExcludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
      setStorageVersion(value => value + 1);
    };
    window.addEventListener("story-owner-settings-updated", onOwnerSettingsUpdate);
    return () => window.removeEventListener("story-owner-settings-updated", onOwnerSettingsUpdate);
  }, []);

  // 公用方案仓库变化（设置页保存/小卷工具写入/迁移）时刷新方案相关 UI
  useEffect(() => {
    const onRepoUpdate = () => {
      setSchemeRepoVersion((value) => value + 1);
      setStorageVersion((value) => value + 1);
    };
    window.addEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
    return () => window.removeEventListener(STORY_SCHEME_REPO_EVENT, onRepoUpdate);
  }, []);

  const autoBottomLockRef = useRef(true);
  const foldToggleSuppressUntilRef = useRef(0);
  // 段落编辑期间：贴底锁必须关掉，否则编辑框自适应高度每次变化都会被
  // ResizeObserver 拽到底部（表现为"一打字就滚到底"）
  const editingMessageIdRef = useRef<string | null>(null);
  useEffect(() => {
    editingMessageIdRef.current = editingMessageId;
    if (editingMessageId) autoBottomLockRef.current = false;
  }, [editingMessageId]);
  // 编辑草稿放 ref、textarea 非受控：逐键 setState 会让 React 回写 value，
  // 中文输入法下 iOS 会光标错位；逐键改 style.height 又会触发 iOS 自动滚动。
  // 高度自适应改由纯 CSS 镜像（.story-grow-wrap::after）完成，打字零 JS 干预。
  const editingDraftRef = useRef("");
  const scrollStoryToBottom = useCallback(() => {
    if (editingMessageIdRef.current) return; // 段落编辑期间任何路径都不允许自动贴底
    const node = scrollRef.current;
    if (!node) return;
    // 已经贴底（或 iOS 橡皮筋回弹超出底部）时不再强写 scrollTop：
    // 否则 ResizeObserver → 贴底 → scroll 事件 → 再贴底会形成每帧循环，
    // 并和 iOS 的回弹动画互相打架
    if (node.scrollHeight - node.scrollTop - node.clientHeight < 1) return;
    const prevBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = "auto";
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
      requestAnimationFrame(() => {
        node.style.scrollBehavior = prevBehavior;
      });
    });
  }, []);

  // Keep the reader at the latest story entry on entry/session switch/message append.
  const prevMsgCountRef = useRef(0);
  const prevScrollSessionRef = useRef("");
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const sessionChanged = prevScrollSessionRef.current !== activeSessionId;
    const shouldStickToBottom = sessionChanged || messages.length > prevMsgCountRef.current || prevMsgCountRef.current === 0;
    prevScrollSessionRef.current = activeSessionId;
    prevMsgCountRef.current = messages.length;
    if (!shouldStickToBottom) return;

    autoBottomLockRef.current = true;
    scrollStoryToBottom();
    const timers = [80, 300, 800, 1600].map((delay) => (
      setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay)
    ));
    return () => timers.forEach(clearTimeout);
  }, [messages.length, activeSessionId, scrollStoryToBottom]);

  useEffect(() => {
    const node = scrollRef.current;
    const inner = node?.querySelector(".story-stage-inner");
    if (!node || !inner || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (performance.now() < foldToggleSuppressUntilRef.current) return;
      if (editingMessageIdRef.current) return; // 编辑中不自动贴底
      if (!autoBottomLockRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scrollStoryToBottom);
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId, scrollStoryToBottom, settingsOpen]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const handleToggle = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      if (!node.contains(target)) return;
      if (!target.matches(".story-fold-block, .story-summary-fold")) return;
      foldToggleSuppressUntilRef.current = performance.now() + 500;
      autoBottomLockRef.current = false;
    };
    node.addEventListener("toggle", handleToggle, true);
    return () => node.removeEventListener("toggle", handleToggle, true);
  }, [activeSessionId, settingsOpen]);

  const currentPreview = useMemo(() => getStoryPreview(messages), [messages]);
  const visibleMessages = useMemo(() => {
    return messages.slice(-visibleMessageCount);
  }, [messages, visibleMessageCount]);
  const hasMoreMessages = visibleMessages.length < messages.length;

  const startAutoReading = useCallback((from: "latest" | "current") => {
    const node = scrollRef.current;
    if (!node || messages.length === 0) return;
    autoBottomLockRef.current = false;

    if (from === "latest" && latestAssistantMessageId) {
      const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(latestAssistantMessageId)
        : latestAssistantMessageId.replace(/["\\]/g, "\\$&");
      const latest = node.querySelector<HTMLElement>(`[data-story-message-id="${escapedId}"]`);
      if (latest) {
        const nodeRect = node.getBoundingClientRect();
        const latestRect = latest.getBoundingClientRect();
        const target = node.scrollTop + latestRect.top - nodeRect.top - node.clientHeight / 2;
        node.scrollTop = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, Math.round(target)));
      }
    }

    setCurrentReadExpanded(false);
    requestAnimationFrame(() => setAutoReading(true));
  }, [latestAssistantMessageId, messages.length]);

  useEffect(() => {
    if (!autoReading) return;
    const node = scrollRef.current;
    if (!node) {
      setAutoReading(false);
      return;
    }

    const speed = Math.max(12, Math.min(120, uiPrefs.autoReadingSpeed ?? DEFAULT_AUTO_READING_SPEED));
    const previousScrollBehavior = node.style.getPropertyValue("scroll-behavior");
    const previousScrollBehaviorPriority = node.style.getPropertyPriority("scroll-behavior");
    // iOS PWA 会让 CSS smooth scrolling 和逐帧 scrollTop 互相抢位置。
    node.style.setProperty("scroll-behavior", "auto", "important");
    let frame = 0;
    let previousTime = performance.now();
    // Safari 会把不足 1px 的 scrollTop 写入取整；单独累计目标位置后再写整数，
    // 慢速（默认每帧约 0.6px）也能稳定前进。
    let desiredScrollTop = node.scrollTop;
    const tick = (time: number) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
      if (desiredScrollTop >= maxScrollTop - 1) {
        node.scrollTop = maxScrollTop;
        setAutoReading(false);
        return;
      }
      const elapsed = Math.min(64, time - previousTime);
      previousTime = time;
      desiredScrollTop = Math.min(maxScrollTop, desiredScrollTop + (speed * elapsed) / 1000);
      node.scrollTop = Math.floor(desiredScrollTop);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      if (previousScrollBehavior) {
        node.style.setProperty("scroll-behavior", previousScrollBehavior, previousScrollBehaviorPriority);
      } else {
        node.style.removeProperty("scroll-behavior");
      }
    };
  }, [autoReading, uiPrefs.autoReadingSpeed]);

  useEffect(() => {
    if (!uiPrefs.autoReadingEnabled && autoReading) setAutoReading(false);
  }, [autoReading, uiPrefs.autoReadingEnabled]);

  const loadMoreMessages = useCallback(() => {
    if (!hasMoreMessages) return;
    const node = scrollRef.current;
    if (node) {
      loadMoreRestoreRef.current = {
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      };
    }
    setVisibleMessageCount((count) => Math.min(count + STORY_LOAD_MORE_COUNT, messages.length));
  }, [hasMoreMessages, messages.length]);

  useLayoutEffect(() => {
    const restore = loadMoreRestoreRef.current;
    const node = scrollRef.current;
    if (!restore || !node) return;
    node.scrollTop = restore.scrollTop + (node.scrollHeight - restore.scrollHeight);
    loadMoreRestoreRef.current = null;
  }, [visibleMessages.length]);

  useEffect(() => {
    messagesLengthRef.current = messages.length;
  }, [messages.length]);

  // 从剧情设置页返回：把滚动位置恢复到进设置之前停留的地方
  useLayoutEffect(() => {
    if (settingsOpen) {
      settingsOpenSnapshotRef.current = {
        sessionId: activeSessionIdRef.current,
        messageCount: messagesLengthRef.current,
      };
      return;
    }
    const snapshot = settingsOpenSnapshotRef.current;
    settingsOpenSnapshotRef.current = null;
    const node = scrollRef.current;
    if (!node || !snapshot) return;
    const contentChanged = snapshot.sessionId !== activeSessionIdRef.current
      || snapshot.messageCount !== messagesLengthRef.current;
    if (contentChanged) {
      // 设置期间切换了角色或有新消息：贴到底部看最新内容（贴底 effect 在设置
      // 打开期间已按旧依赖跑过空转，返回时不会再触发，需要在这里补一次）
      autoBottomLockRef.current = true;
      scrollStoryToBottom();
      const stickTimers = [80, 300, 800].map((delay) => window.setTimeout(() => {
        if (autoBottomLockRef.current) scrollStoryToBottom();
      }, delay));
      return () => stickTimers.forEach((id) => window.clearTimeout(id));
    }
    const target = stageScrollMemoRef.current;
    if (target <= 0) return;
    autoBottomLockRef.current = false; // 恢复期间不要被贴底逻辑拽走
    // .story-stage 的 CSS scroll-behavior:smooth 会把 scrollTop 赋值变成
    // 平滑滚动动画（表现为"返回后看着页面从顶部一路滑下来"，很晕）。
    // 恢复期间用内联样式强制瞬时定位，全部校正结束后再交还给 CSS。
    node.style.scrollBehavior = "auto";
    let done = false;
    let cancelled = false;
    const timers: number[] = [];
    const restoreBehavior = () => {
      if (done) return;
      done = true;
      if (node.style.scrollBehavior === "auto") node.style.scrollBehavior = "";
    };
    const apply = () => {
      if (cancelled) return;
      const max = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(target, max);
    };
    apply();
    // iOS 上刚挂载的容器同帧写 scrollTop 偶发不生效；rAF 回调仍在首帧
    // 绘制前执行，补写一次确保用户看到的第一帧就是目标位置
    requestAnimationFrame(apply);
    // 状态栏/小剧场 iframe 高度异步确定，内容高度随后会变，补几次校正；
    // 校正期间保持瞬时定位，最后一次校正结束后才还原平滑滚动
    [80, 300, 800].forEach((delay, index) => timers.push(window.setTimeout(() => {
      if (cancelled) return;
      apply();
      if (index === 2) restoreBehavior();
    }, delay)));
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      restoreBehavior();
    };
    // 用户一动手（触摸/滚轮）就停止校正，避免和手动滚动打架
    node.addEventListener("pointerdown", cancel, { capture: true, once: true });
    node.addEventListener("wheel", cancel, { capture: true, once: true, passive: true });
    return () => {
      cancel();
      node.removeEventListener("pointerdown", cancel, { capture: true });
      node.removeEventListener("wheel", cancel, { capture: true });
    };
  }, [settingsOpen, scrollStoryToBottom]);

  const handleOptionSelect = useCallback((text: string) => {
    composerAppendIdRef.current += 1;
    setComposerAppendRequest({ id: composerAppendIdRef.current, text });
  }, []);

  // Close context menu when clicking outside (delay to avoid the opening tap closing it)
  useEffect(() => {
    if (!activeMessageId) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".story-ctx-menu")) {
        setActiveMessageId(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("click", handler, true);
    }, 300);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("click", handler, true);
    };
  }, [activeMessageId]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    if (!ready || !activeCharacterId || !currentSession || isGenerating || isReadOnly || mergingPage) return;

    const activeAssistantMessages = messages.filter((message) => message.role === "assistant");
    if (activeAssistantMessages.length === 0) return;

    // 配置解析可能抛错（如绑定的 API 配置已被删除）；这里在渲染 effect 里，
    // 抛出去会让整个剧情页白屏，所以失败时跳过缓存刷新，错误留到发送时提示
    let signature: { regexSignature: string; parserVersion: number };
    try {
      signature = getStoryRenderSignature(activeCharacterId, currentSession.foldTags);
    } catch {
      return;
    }
    const { regexSignature, parserVersion } = signature;
    const hasStaleMessage = activeAssistantMessages.some((message) => (
      !message.renderedContent
      || message.regexSignature !== regexSignature
      || message.parserVersion !== parserVersion
    ));
    if (!hasStaleMessage) return;

    const refreshKey = `${activeCharacterId}:${currentSession.id}`;
    if (cacheRefreshKeyRef.current === refreshKey) return;
    cacheRefreshKeyRef.current = refreshKey;

    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;

    const runRefresh = () => {
      if (cancelled) return;
      let rebuilt: StoryMessage[];
      try {
        rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
      } catch {
        if (cacheRefreshKeyRef.current === refreshKey) cacheRefreshKeyRef.current = null;
        return;
      }
      if (cancelled) return;
      if (activeSessionIdRef.current === currentSession.id) {
        setMessages(rebuilt);
      }
      setStorageVersion((value) => value + 1);
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };

    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(runRefresh, { timeout: 700 });
    } else {
      timeoutId = globalThis.setTimeout(runRefresh, 80) as unknown as number;
    }

    return () => {
      cancelled = true;
      if (timeoutId != null) {
        globalThis.clearTimeout(timeoutId);
      }
      if (idleId != null && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleId);
      }
      if (cacheRefreshKeyRef.current === refreshKey) {
        cacheRefreshKeyRef.current = null;
      }
    };
    // 依赖用 id/foldTags 原始值而不是 session 对象：会话缓存归一化会更换对象
    // 引用，按对象依赖会让本 effect 在无关渲染中反复重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeCharacterId, currentSession?.id, currentSession?.foldTags, messages, isGenerating, isReadOnly, mergingPage]);

  function applySessionUpdates(updates: Partial<StorySession>) {
    if (!currentSession || isReadOnly || mergingPageRef.current) return;
    const next = updateStorySession(currentSession.id, updates);
    if (!next) return;
    setCustomCssDraft(next.customCSS || "");
    setFoldTagsDraft(next.foldTags ?? DEFAULT_STORY_FOLD_TAGS);
    setContextExcludedTagsDraft(next.contextExcludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
    setStorageVersion((value) => value + 1);
  }

  function handleStoryCharacterChange(characterId: string) {
    if (!characters.some((character) => character.id === characterId)) return;
    setActiveGroupId("");
    setActiveCharacterId(characterId);
    activateStorySession(resolveOwnerSession("single", characterId, characterId, [characterId]));
  }

  function handleStoryGroupSelect(groupId: string) {
    const group = loadStoryGroups().find((item) => item.id === groupId);
    if (!group) return;
    const primaryId = group.characterIds.find((id) => characters.some((character) => character.id === id));
    if (!primaryId) return;
    setActiveGroupId(group.id);
    setActiveCharacterId(primaryId);
    activateStorySession(resolveOwnerSession("group", group.id, primaryId, group.characterIds));
  }

  function handleStoryGroupCreate(characterIds: string[], name: string) {
    const validIds = Array.from(new Set(characterIds.filter((id) => characters.some((character) => character.id === id))));
    if (validIds.length < 2) return;
    const group = createStoryGroup(validIds, name);
    const primaryId = validIds[0];
    const baseSession = loadStorySessionsForOwner("single", primaryId).find((session) => (session.branchId || "main") === "main");
    const session = createOrGetStorySession(primaryId, {
      ownerType: "group",
      ownerId: group.id,
      participantIds: validIds,
      branchId: "main",
      baseSession,
    });
    setActiveGroupId(group.id);
    setActiveCharacterId(primaryId);
    activateStorySession(session);
  }

  function handleStoryGroupDelete(groupId: string) {
    if (mergingPageRef.current) return;
    const deletingActive = activeGroupId === groupId;
    deleteStoryGroup(groupId);
    if (deletingActive && activeCharacterId) {
      setActiveGroupId("");
      activateStorySession(resolveOwnerSession("single", activeCharacterId, activeCharacterId, [activeCharacterId]));
    } else {
      setStorageVersion((value) => value + 1);
    }
  }

  function handleStorySessionSelect(sessionId: string) {
    const session = loadStorySessions().find((item) => item.id === sessionId);
    if (!session) return;
    activateStorySession(session);
  }

  function handleStoryBranchCreate(input: { name: string; inheritRecentMemory: boolean; independentStory: boolean }) {
    if (!activeOwnerId || !activeCharacterId) return;
    const mainSession = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).find((session) => (session.branchId || "main") === "main") || currentSession || undefined;
    const session = createOrGetStorySession(activeCharacterId, {
      ownerType: activeOwnerType,
      ownerId: activeOwnerId,
      participantIds: activeGroup?.characterIds || [activeCharacterId],
      branchId: `branch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      branchName: input.name,
      inheritRecentMemory: input.inheritRecentMemory,
      independentStory: input.independentStory,
      baseSession: mainSession,
    });
    activateStorySession(session);
  }

  async function handleStoryBranchMerge(sessionId: string) {
    if (mergingPageRef.current) return;
    if (getGeneratingStorySessionIds().size || floatingChatGenerating) {
      alert("请先等待剧情和悬浮聊天生成结束，再合并分页。");
      return;
    }
    const page = loadStorySessions().find(item => item.id === sessionId);
    if (!page || page.mergedIntoSessionId || page.independentStory) return;
    const records = loadStoryMessages(sessionId);
    if (!records.length) { alert("这个分页没有可合并的记录。"); return; }
    const range = `${new Date(records[0].createdAt).toLocaleString()} — ${new Date(records[records.length - 1].createdAt).toLocaleString()}`;
    if (!window.confirm(`将「${page.branchName || "分线剧情"}」的 ${records.length} 条记录合并进同一角色／多人组的主线？\n\n记录时间：${range}\n\n正文和摘要按原发送时间插入，不覆盖主线，不重复生成记忆。原分页将变为只读归档，内容随主线对应记录同步。此操作没有一键撤销，请先备份；请确认这些内容属于同一段连续经历。`)) return;
    mergingPageRef.current = true;
    setMergingPage(true);
    try {
      const main = await mergeStoryPageIntoMain(sessionId);
      setActiveMessageId(null);
      setEditingMessageId(null);
      setActionRequest(null);
      activateStorySession(main);
      setSettingsOpen(false);
      setStorageVersion(value => value + 1);
    } catch (error) {
      alert(error instanceof Error ? error.message : "合并失败，请重试。");
    } finally {
      mergingPageRef.current = false;
      setMergingPage(false);
    }
  }

  function handleStoryBranchDelete(sessionIds: string[]) {
    if (mergingPageRef.current) return;
    const deletingActive = sessionIds.includes(activeSessionId);
    deleteStorySessions(sessionIds);
    if (deletingActive) {
      const main = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).find((session) => (session.branchId || "main") === "main");
      if (main) activateStorySession(main);
    } else {
      setStorageVersion((value) => value + 1);
    }
  }

  function handleStorySessionUpdate(sessionId: string, updates: Partial<StorySession>) {
    if (mergingPageRef.current || loadStorySessions().find(item => item.id === sessionId)?.mergedIntoSessionId) return;
    const next = updateStorySession(sessionId, updates);
    if (!next) return;
    if (next.id === activeSessionId) {
      setCustomCssDraft(next.customCSS || "");
      setFoldTagsDraft(next.foldTags ?? DEFAULT_STORY_FOLD_TAGS);
      setContextExcludedTagsDraft(next.contextExcludedTags ?? DEFAULT_STORY_CONTEXT_EXCLUDED_TAGS);
    }
    setStorageVersion((value) => value + 1);
  }

  function cleanStoryTextForExport(text: string): string {
    return text
      .replace(/<(?:think|thinking|story_status|story_theater|summary)[^>]*>[\s\S]*?<\/(?:think|thinking|story_status|story_theater|summary)>/gi, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function storyChapterTitle(session: StorySession, branchIndex: number): string {
    if ((session.branchId || "main") === "main") return "主线";
    return `分线${branchIndex}「${session.branchName || `分线剧情 ${branchIndex}`}」`;
  }

  function buildStoryTxt(session: StorySession, chapterTitle: string, includeBookTitle = true): string {
    const rows = loadStoryMessages(session.id)
      .map((message) => {
        const content = cleanStoryTextForExport(message.renderedContent || message.rawContent);
        if (!content) return "";
        const speaker = message.role === "assistant" ? storyDisplayName : message.role === "user" ? (userIdentity?.name || "我") : "旁白";
        return `${speaker}\n${content}`;
      })
      .filter(Boolean);
    return [includeBookTitle ? `《${storyDisplayName}》` : "", chapterTitle, "", ...rows].filter((item, index) => index !== 0 || Boolean(item)).join("\n\n");
  }

  function safeStoryFilename(value: string): string {
    return value.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60) || "剧情";
  }

  function handleExportStorySession(sessionId: string) {
    const session = loadStorySessions().find((item) => item.id === sessionId);
    if (!session) return;
    const ownerSessions = loadStorySessionsForOwner(session.ownerType || "single", session.ownerId || session.characterId);
    const branchIndex = Math.max(1, ownerSessions.filter((item) => (item.branchId || "main") !== "main").findIndex((item) => item.id === session.id) + 1);
    const chapterTitle = storyChapterTitle(session, branchIndex);
    const blob = new Blob([buildStoryTxt(session, chapterTitle)], { type: "text/plain;charset=utf-8" });
    void downloadFile(blob, `${safeStoryFilename(storyDisplayName)}-${safeStoryFilename(chapterTitle)}.txt`)
      .catch((error) => alert(error instanceof Error ? error.message : "导出失败"));
  }

  function handleExportAllStories() {
    const sessions = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).filter(item => !item.mergedIntoSessionId);
    let branchIndex = 0;
    const chapters = sessions.map((session) => {
      if ((session.branchId || "main") !== "main") branchIndex += 1;
      return { session, title: storyChapterTitle(session, Math.max(1, branchIndex)) };
    });
    const directory = ["目录", ...chapters.map((chapter) => chapter.title)].join("\n");
    const sections = chapters.map((chapter) => buildStoryTxt(chapter.session, chapter.title, false));
    const text = [`《${storyDisplayName}》`, directory, ...sections].join("\n\n\n====================\n\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    void downloadFile(blob, `${safeStoryFilename(storyDisplayName)}-全部剧情.txt`)
      .catch((error) => alert(error instanceof Error ? error.message : "导出失败"));
  }

  function handleExportSelectedStories(sessionIds: string[]) {
    const selected = new Set(sessionIds);
    const sessions = loadStorySessionsForOwner(activeOwnerType, activeOwnerId).filter((session) => selected.has(session.id));
    if (!sessions.length) return;
    let branchIndex = 0;
    const chapters = loadStorySessionsForOwner(activeOwnerType, activeOwnerId)
      .map((session) => {
        if ((session.branchId || "main") !== "main") branchIndex += 1;
        return { session, title: storyChapterTitle(session, Math.max(1, branchIndex)) };
      })
      .filter(({ session }) => selected.has(session.id));
    const directory = ["目录", ...chapters.map((chapter) => chapter.title)].join("\n");
    const sections = chapters.map((chapter) => buildStoryTxt(chapter.session, chapter.title, false));
    const text = [`《${storyDisplayName}》`, directory, ...sections].join("\n\n\n====================\n\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    void downloadFile(blob, `${safeStoryFilename(storyDisplayName)}-所选剧情.txt`)
      .catch((error) => alert(error instanceof Error ? error.message : "导出失败"));
  }

  async function handleMergeStoryBranches(sessionIds: string[]) {
    if (mergingPageRef.current || getGeneratingStorySessionIds().size) return;
    mergingPageRef.current = true;
    setMergingPage(true);
    let count = 0;
    const skipped: string[] = [];
    try {
      const candidates = loadStorySessionsForOwner(activeOwnerType, activeOwnerId);
      for (const id of new Set(sessionIds)) {
        const source = candidates.find(item => item.id === id);
        if (!source || source.independentStory || source.mergedIntoSessionId || source.mergedIntoMainAt || (source.branchId || "main") === "main") {
          skipped.push(source?.branchName || id);
          continue;
        }
        await mergeStoryPageIntoMain(id);
        count++;
      }
      if (activeSessionIdRef.current) setMessages(loadStoryMessages(activeSessionIdRef.current));
      alert(`已合并并只读归档 ${count} 条分页${skipped.length ? `；跳过 ${skipped.length} 条主线、独立或已归档分页` : ""}。`);
    } catch (error) {
      alert(`已完成 ${count} 条合并，后续合并停止：${error instanceof Error ? error.message : "合并失败"}`);
    } finally {
      mergingPageRef.current = false;
      setMergingPage(false);
      setStorageVersion(value => value + 1);
    }
  }

  function handleQuickStoryCreate() {
    if (mergingPageRef.current) return;
    if (!activeOwnerId || !activeCharacterId) return;
    const now = new Date();
    const branchName = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const baseSession = ownerMainSession || currentSession || undefined;
    if (currentSession && !isReadOnly) updateStorySession(currentSession.id, { endedAt: now.toISOString() });
    const session = createOrGetStorySession(activeCharacterId, {
      ownerType: activeOwnerType,
      ownerId: activeOwnerId,
      participantIds: activeGroup?.characterIds || [activeCharacterId],
      branchId: `quick_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      branchName,
      inheritRecentMemory: !quickStoryIndependent,
      independentStory: quickStoryIndependent,
      baseSession,
    });
    const prompt = quickStoryIndependent
      ? `这是一个独立的新剧情，不继承主线上下文。请由${storyDisplayName}自然开启一个全新的见面场景。`
      : `当前剧情已经结束，请结合最近上下文，由${storyDisplayName}自然开启一段新的见面剧情。`;
    const next = updateStorySession(session.id, { autoStartPrompt: prompt, autoStartRequestedAt: now.toISOString() }) || session;
    setQuickStoryOpen(false);
    setQuickStoryIndependent(false);
    activateStorySession(next);
  }

  const showVoiceNotice = useCallback((message: string) => {
    setVoiceNotice(message);
    if (voiceNoticeTimerRef.current) clearTimeout(voiceNoticeTimerRef.current);
    voiceNoticeTimerRef.current = setTimeout(() => setVoiceNotice(null), 2600);
  }, []);

  const playStoryVoice = useCallback(async (segment: StoryVoiceSegment): Promise<boolean> => {
    if (!activeCharacterId || !segment.text.trim()) return false;

    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("请先在剧情语音中开启语音");
      return false;
    }

    if (playingVoiceSegmentId === segment.id) {
      voiceRequestIdRef.current += 1;
      voicePlaybackRef.current?.abort();
      voicePlaybackRef.current = null;
      setPlayingVoiceSegmentId(null);
      return false;
    }

    const voiceConfig = resolveVoiceConfig(activeCharacterId, "story");
    if (!voiceConfig || !voiceConfig.enableTTS) {
      showVoiceNotice("请先在配置绑定中为剧情绑定可用的语音方案");
      return false;
    }

    unlockAudioPlayback();
    voiceRequestIdRef.current += 1;
    const requestId = voiceRequestIdRef.current;
    voicePlaybackRef.current?.abort();
    voicePlaybackRef.current = null;
    setPlayingVoiceSegmentId(segment.id);

    try {
      const cacheKey = `${voiceConfig.id}:${voiceConfig.speechSpeed ?? 1}:${segment.text}`;
      let blob = storyVoiceCache.get(cacheKey) || null;
      if (!blob) {
        blob = await synthesizeSpeech(segment.text, voiceConfig);
        if (blob) cacheStoryVoice(cacheKey, blob);
      }
      if (requestId !== voiceRequestIdRef.current) return false;
      if (!blob) throw new Error("语音服务没有返回音频");

      const playback = playAudioBlobViaMediaElement(blob);
      voicePlaybackRef.current = playback;
      await playback.promise;
      return requestId === voiceRequestIdRef.current;
    } catch (error) {
      if (requestId === voiceRequestIdRef.current) {
        showVoiceNotice(error instanceof Error ? error.message : "语音播放失败，请检查语音配置");
      }
      return false;
    } finally {
      if (requestId === voiceRequestIdRef.current) {
        voicePlaybackRef.current = null;
        setPlayingVoiceSegmentId(null);
      }
    }
  }, [activeCharacterId, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  const handleStoryVoicePlay = useCallback((segment: StoryVoiceSegment) => {
    void playStoryVoice(segment);
  }, [playStoryVoice]);

  const collectStoryVoiceSegments = useCallback((): StoryVoiceSegment[] => {
    const stage = scrollRef.current;
    if (!stage) return [];
    const assistantRows = Array.from(stage.querySelectorAll<HTMLElement>('.story-row[data-role="assistant"]'));
    const latestRowWithDialogue = assistantRows.reverse().find((row) => row.querySelector("[data-story-voice-segment]"));
    if (!latestRowWithDialogue) return [];
    return Array.from(latestRowWithDialogue.querySelectorAll<HTMLElement>("[data-story-voice-segment]")).flatMap((element) => {
      const id = element.dataset.storyVoiceSegment;
      const encodedText = element.dataset.storyVoiceText;
      if (!id || !encodedText) return [];
      return [{
        id,
        text: decodeURIComponent(encodedText),
        speaker: element.dataset.storyVoiceSpeaker
          ? decodeURIComponent(element.dataset.storyVoiceSpeaker)
          : undefined,
      }];
    });
  }, []);

  const handlePlayNextStoryVoice = useCallback(async () => {
    if (!uiPrefs.voiceEnabled) {
      showVoiceNotice("请先在剧情语音中开启语音");
      return;
    }
    if (playingVoiceSegmentId) return;
    const segments = collectStoryVoiceSegments();
    if (segments.length === 0) {
      showVoiceNotice("当前页面还没有可播放的角色对白");
      return;
    }

    let index = voiceSequenceIndexRef.current;
    if (index >= segments.length) {
      const restart = window.confirm("已经播放完，是否从头开始？");
      if (!restart) return;
      index = 0;
      voiceSequenceIndexRef.current = 0;
    }
    setVoiceSequenceProgress({ current: index + 1, total: segments.length });
    const completed = await playStoryVoice(segments[index]);
    if (!completed) return;

    const nextIndex = index + 1;
    if (nextIndex < segments.length) {
      voiceSequenceIndexRef.current = nextIndex;
      return;
    }

    voiceSequenceIndexRef.current = segments.length;
  }, [collectStoryVoiceSegments, playStoryVoice, playingVoiceSegmentId, showVoiceNotice, uiPrefs.voiceEnabled]);

  async function handleSend(userTextInput: string, kind?: "director") {
    const userText = userTextInput.trim();
    if (!activeSessionId || !userText || isGenerating || isReadOnly || mergingPageRef.current) return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;

    const userMessage = pushStoryMessage({
      sessionId,
      role: "user",
      kind,
      rawContent: userText,
      renderedContent: userText,
    });
    setMessages((prev) => [...prev, userMessage]);
    setStorageVersion((value) => value + 1);
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => isStoryGenerationRunActive(sessionId, generationRunId);

    try {
      const historyForGeneration = loadStoryMessages(sessionId);
      const result = await generateStoryCompletion(characterId, historyForGeneration, {
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        globalSettings: storyGlobalSettings,
        floatingChatContext: currentSession?.independentStory ? "" : floatingChatContext,
        participantIds: currentSession?.participantIds || [characterId],
        storyMemory: {
          independent: currentSession?.independentStory,
          inheritRecentMemory: currentSession?.inheritRecentMemory ?? true,
          startedAt: currentSession?.createdAt,
        },
        onDelta: storyGlobalSettings.streamingEnabled ? (delta) => appendStoryStreamDelta(sessionId, delta) : undefined,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      const assistantMessage = pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      refreshGenerationView(sessionId);

      const memoryCharacterIds = currentSession?.participantIds?.length ? currentSession.participantIds : [characterId];
      const storyCharacters = memoryCharacterIds
        .map((id) => characters.find((character) => character.id === id))
        .filter((item): item is NonNullable<typeof item> => Boolean(item));
      if (storyCharacters.length && !currentSession?.independentStory) {
        void (async () => {
          try {
            for (const storyCharacter of storyCharacters) {
              incrementEventCounter(storyCharacter.id);
              incrementEventCounter(storyCharacter.id);
              await maybeRunSummarization(storyCharacter.id, storyCharacter.name);
            }
          } catch (err) {
            console.warn("[StoryApp] Memory counter/summarization failed:", err);
          }
        })();
      }
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "剧情生成失败，请稍后再试。";
      const systemMessage = pushStoryMessage({
        sessionId,
        role: "system",
        rawContent: errText,
        renderedContent: errText,
      });
      refreshGenerationView(sessionId);
    } finally {
      clearStoryStream(sessionId);
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  // 私聊邀请/快捷新分线进入后，由角色直接开场；提示只参与本次生成，不渲染成用户气泡。
  useEffect(() => {
    const session = currentSession;
    const prompt = session?.autoStartPrompt?.trim();
    if (!ready || !session || !prompt || !activeCharacterId || isGenerating || session.mergedIntoSessionId || session.mergedIntoMainAt || mergingPageRef.current) return;
    if (autoStartedSessionIdsRef.current.has(session.id)) return;
    autoStartedSessionIdsRef.current.add(session.id);
    updateStorySession(session.id, { autoStartPrompt: undefined, autoStartRequestedAt: undefined });

    const sessionId = session.id;
    const characterId = activeCharacterId;
    const virtualMessage: StoryMessage = {
      id: `story_auto_${Date.now()}`,
      sessionId,
      role: "user",
      rawContent: prompt,
      renderedContent: prompt,
      createdAt: session.autoStartRequestedAt || new Date().toISOString(),
    };
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => isStoryGenerationRunActive(sessionId, generationRunId);

    void generateStoryCompletion(characterId, [...loadStoryMessages(sessionId), virtualMessage], {
      sessionFoldTags: session.foldTags,
      sessionContextExcludedTags: session.contextExcludedTags,
      settings: session.settings,
      globalSettings: storyGlobalSettings,
      floatingChatContext: session.independentStory ? "" : floatingChatContext,
      participantIds: session.participantIds || [characterId],
      storyMemory: {
        independent: session.independentStory,
        inheritRecentMemory: session.inheritRecentMemory ?? true,
        startedAt: session.createdAt,
      },
      onDelta: storyGlobalSettings.streamingEnabled ? (delta) => appendStoryStreamDelta(sessionId, delta) : undefined,
      signal: generationRun.controller.signal,
    }).then((result) => {
      if (!isCurrentGeneration()) return;
      pushStoryMessage({
        sessionId,
        role: "assistant",
        rawContent: result.rawText,
        renderedContent: result.renderedText,
        storySummary: result.storySummary,
        regexSignature: result.regexSignature,
        parserVersion: result.parserVersion,
      });
      refreshGenerationView(sessionId);

      if (!session.independentStory) {
        for (const id of session.participantIds?.length ? session.participantIds : [characterId]) {
          const item = characters.find((candidate) => candidate.id === id);
          if (!item) continue;
          incrementEventCounter(item.id);
          void maybeRunSummarization(item.id, item.name).catch(() => undefined);
        }
      }
    }).catch((error) => {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const text = error instanceof Error ? error.message : "剧情自动开场失败，请点击续写重试。";
      pushStoryMessage({ sessionId, role: "system", rawContent: text, renderedContent: text });
      refreshGenerationView(sessionId);
    }).finally(() => {
      clearStoryStream(sessionId);
      if (finishStoryGenerationRun(sessionId, generationRunId)) markGenerating(sessionId, false);
    });
  }, [activeCharacterId, activeSessionId, currentSession?.autoStartPrompt, ready, storyGlobalSettings.streamingEnabled, storyGlobalSettings.timeAware]);

  function appendFloatingStoryTrace(
    title: string,
    lines: string[],
    storySessionId = activeSessionId,
    renderedContent?: string,
    contextRole?: StoryMessage["role"],
  ) {
    if (!storySessionId) return;
    const stamp = new Date().toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const transcript = [`【${title} · ${stamp}】`, ...lines].join("\n");
    pushStoryMessage({ sessionId: storySessionId, role: "system", contextRole, rawContent: transcript, renderedContent: renderedContent || transcript });
    if (activeSessionIdRef.current === storySessionId) setMessages(loadStoryMessages(storySessionId));
    setStorageVersion((value) => value + 1);
  }

  function appendEmbeddedChatTrace(message: ChatMessage, session: ChatSession) {
    const supported = new Set<ChatMessage["mediaType"]>(["audio", "image", "transfer", "location", "gift"]);
    if (!message.mediaType || !supported.has(message.mediaType)) return;
    const userName = userIdentity?.name || "用户";
    const targetName = session.isGroup
      ? (session.groupName || "群聊")
      : (characters.find((item) => item.id === session.contactId)?.name || "对方");
    const data = message.mediaData || {};
    let kind = "特殊消息";
    let detail = message.content || data.label || "";
    if (message.mediaType === "audio") {
      kind = "语音";
      detail = data.label || message.content || "发送了一条语音";
    } else if (message.mediaType === "image") {
      kind = "图片";
      detail = data.label || message.content || "发送了一张图片";
    } else if (message.mediaType === "transfer") {
      kind = "转账";
      const recipient = data.recipientName ? `给 ${data.recipientName}` : `给 ${targetName}`;
      detail = `${recipient} ¥${Number(data.amount || 0).toFixed(2)}${data.label ? ` · ${data.label}` : ""}`;
    } else if (message.mediaType === "location") {
      kind = "位置";
      detail = data.label || message.content || "分享了一个位置";
    } else if (message.mediaType === "gift") {
      kind = "礼物";
      const recipient = data.recipientName ? `送给 ${data.recipientName}` : `送给 ${targetName}`;
      detail = `${recipient} · ${data.giftName || data.label || "礼物"}`;
    }
    const createdAt = new Date(message.createdAt).toLocaleString();
    const rendered = `<div class="story-online-trace-card" data-trace-kind="${escapeStoryTraceHtml(kind)}"><div class="story-online-trace-head"><strong>${escapeStoryTraceHtml(kind)}</strong><span>${escapeStoryTraceHtml(createdAt)}</span></div><div class="story-online-trace-body"><b>${escapeStoryTraceHtml(userName)}</b><span> → ${escapeStoryTraceHtml(targetName)}</span><p>${escapeStoryTraceHtml(detail)}</p></div></div>`;
    appendFloatingStoryTrace(`线上${kind}`, [
      `发送人：${userName}`,
      `发送到：${targetName}`,
      `内容：${detail}`,
    ], activeSessionIdRef.current, rendered, "user");
  }

  async function completeFloatingOnlineRound(chatSession: ChatSession, userTrace: string, storySessionId: string) {
    const characterId = activeCharacterId;
    const characterName = currentCharacter?.name || "角色";
    const history = loadChatMessages(chatSession.id);
    const replyLines: string[] = [];
    if (activeGroup) {
      const results = await generateGroupChatCompletion(chatSession, history, undefined, { appTags: ["group_chat", "text"] });
      if (!results.length) throw new Error("群聊没有返回可显示的聊天内容");
      results.forEach((result) => {
        const parsed = parseAIResponse(result.responseText, []);
        const parts = parsed.parts.length ? parsed.parts : [{ content: result.responseText }];
        parts.forEach((part, index) => {
          pushChatMessage({
            sessionId: chatSession.id, role: "assistant", content: part.content,
            mediaType: part.mediaType, mediaData: part.mediaData,
            senderCharacterId: result.characterId, senderName: result.characterName,
            origin: "story_floating_phone",
            statusPanel: index === 0 ? (parsed.statusPanel || undefined) : undefined,
            innerMonologue: index === 0 ? (parsed.innerMonologue || undefined) : undefined,
            stateValues: index === 0 && parsed.stateValues.length ? parsed.stateValues : undefined,
            freshStateValues: index === 0 && parsed.freshStateValues.length ? parsed.freshStateValues : undefined,
          });
          const visible = part.content.trim() || part.mediaData?.label || (part.mediaType ? `[${part.mediaType}]` : "");
          if (visible) replyLines.push(`${result.characterName}：${visible}`);
        });
      });
    } else {
      const completion = await generateChatCompletion(chatSession, history, { appTags: ["chat", "text"], appId: "chat" });
      const rawReply = flattenCompletionResult(completion).trim();
      if (!rawReply) throw new Error("角色没有返回可显示的聊天内容");
      const previousState = [...history].reverse().find((item) => item.stateValues?.length)?.stateValues || [];
      const parsed = parseAIResponse(rawReply, previousState);
      const parts = parsed.parts.length ? parsed.parts : [{ content: rawReply }];
      parts.forEach((part, index) => {
        pushChatMessage({
          sessionId: chatSession.id, role: "assistant", content: part.content,
          mediaType: part.mediaType, mediaData: part.mediaData,
          senderCharacterId: characterId, senderName: characterName, origin: "story_floating_phone",
          statusPanel: index === 0 ? (parsed.statusPanel || undefined) : undefined,
          innerMonologue: index === 0 ? (parsed.innerMonologue || undefined) : undefined,
          stateValues: index === 0 && parsed.stateValues.length ? parsed.stateValues : undefined,
          freshStateValues: index === 0 && parsed.freshStateValues.length ? parsed.freshStateValues : undefined,
        });
        const visible = part.content.trim() || part.mediaData?.label || (part.mediaType ? `[${part.mediaType}]` : "");
        if (visible) replyLines.push(`${characterName}：${visible}`);
      });
    }
    appendFloatingStoryTrace("线上互动", [userTrace, ...replyLines], storySessionId);
    // 这轮互动已在悬浮小手机中看过，不在剧情 APP 外保留未读红点。
    markChatSessionRead(chatSession.id);
    setFloatingChatVersion((value) => value + 1);
  }

  async function handleFloatingChatSend() {
    const text = floatingChatDraft.trim();
    if (!text || !activeCharacterId || floatingChatGenerating) return;
    const storySessionId = activeSessionId;
    const characterId = activeCharacterId;
    const userName = userIdentity?.name || "用户";
    setFloatingChatDraft("");
    setFloatingPlusOpen(false);
    if (independentFloatingShell) {
      appendFloatingStoryTrace("剧情小手机", [`${userName}：${text}`], storySessionId);
      return;
    }
    setFloatingChatGenerating(true);
    try {
      await hydrateChatStorage();
      const chatSession = activeGroup ? floatingChatSession : createOrGetSession(characterId);
      if (!chatSession) throw new Error("若没有群聊建议先建一个群聊");
      pushChatMessage({ sessionId: chatSession.id, role: "user", content: text, origin: "story_floating_phone" });
      setFloatingChatVersion((value) => value + 1);
      await completeFloatingOnlineRound(chatSession, `${userName}：${text}`, storySessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "悬浮聊天发送失败";
      const chatSession = floatingChatSession || loadChatSessions().find((item) => item.contactId === characterId && !item.isGroup);
      if (chatSession) pushChatMessage({ sessionId: chatSession.id, role: "system", content: `⚠️ ${message}` });
      setFloatingChatVersion((value) => value + 1);
      showVoiceNotice(message);
    } finally {
      setFloatingChatGenerating(false);
    }
  }

  async function handleFloatingRichSend(
    mediaType: NonNullable<ChatMessage["mediaType"]>,
    mediaData: ChatMessage["mediaData"],
    traceText: string,
    mediaUrl?: string,
  ) {
    if (!activeCharacterId || floatingChatGenerating) return;
    const storySessionId = activeSessionId;
    const userName = userIdentity?.name || "用户";
    setFloatingRichKind(null);
    setFloatingPlusOpen(false);
    if (independentFloatingShell) {
      appendFloatingStoryTrace("剧情小手机", [`${userName}${traceText}`], storySessionId, undefined, "user");
      return;
    }
    setFloatingChatGenerating(true);
    try {
      await hydrateChatStorage();
      const chatSession = activeGroup ? floatingChatSession : createOrGetSession(activeCharacterId);
      if (!chatSession) throw new Error("若没有群聊建议先建一个群聊");
      let nextMediaData = mediaData;
      if (mediaType === "transfer") {
        const amount = Number(mediaData?.amount || 0);
        const payment = payWithWalletBalance({
          amount,
          title: "剧情小手机转账",
          detail: `${activeGroup ? chatSession.groupName || "群聊" : currentCharacter?.name || "角色"}：转账 ${amount.toFixed(2)} 元`,
          category: "转账",
        });
        if (!payment.ok || !payment.transaction) throw new Error(payment.error || "余额不足，无法转账");
        nextMediaData = { ...mediaData, walletTransactionId: payment.transaction.id };
      }
      pushChatMessage({
        sessionId: chatSession.id,
        role: "user",
        content: "",
        mediaType,
        mediaData: nextMediaData,
        ...(mediaUrl ? { mediaUrl } : {}),
        origin: "story_floating_phone",
      });
      setFloatingChatVersion((value) => value + 1);
      await completeFloatingOnlineRound(chatSession, `${userName}${traceText}`, storySessionId);
    } catch (error) {
      showVoiceNotice(error instanceof Error ? error.message : "悬浮互动发送失败");
    } finally {
      setFloatingChatGenerating(false);
      setFloatingTransferTargetId("");
    }
  }

  function handleFloatingMomentPublished(post: MomentPost) {
    const createdAt = new Date(post.createdAt).toLocaleString();
    const userName = userIdentity?.name || "用户";
    const details = [
      `${userName}发布了动态：${post.content}`,
      post.location ? `位置：${post.location}` : "",
      post.photoUrl || post.photoDescription ? `图片：${post.photoDescription || "已附图片"}` : "",
    ].filter(Boolean);
    const rendered = `<div class="story-online-trace-card" data-trace-kind="动态"><div class="story-online-trace-head"><strong>动态</strong><span>${escapeStoryTraceHtml(createdAt)}</span></div><div class="story-online-trace-body"><b>${escapeStoryTraceHtml(userName)}</b><p>${escapeStoryTraceHtml(post.content)}</p>${post.location ? `<small>位置 · ${escapeStoryTraceHtml(post.location)}</small>` : ""}${post.photoUrl || post.photoDescription ? `<small>图片 · ${escapeStoryTraceHtml(post.photoDescription || "已附图片")}</small>` : ""}</div></div>`;
    appendFloatingStoryTrace("动态", details, activeSessionIdRef.current, rendered, "user");
  }

  function publishIsolatedMoment() {
    const content = isolatedMomentDraft.trim();
    if (!content) return;
    appendFloatingStoryTrace("剧情朋友圈", [`${userIdentity?.name || "用户"}：${content}`], activeSessionId, undefined, "user");
    setIsolatedMomentDraft("");
    setIsolatedMomentComposerOpen(false);
  }

  function openFloatingRichPanel(kind: Exclude<FloatingRichKind, null>) {
    // 与聊天室一致：选择功能后先收起“+”菜单，再显示对应操作面板。
    setFloatingPlusOpen(false);
    setFloatingRichKind(kind);
  }

  function handleStopGeneration() {
    if (!activeSessionId) return;
    const cancelled = cancelStoryGenerationRun(activeSessionId);
    if (!cancelled && !isGenerating) return;
    markGenerating(activeSessionId, false);
  }

  function handleTouchStart(clientX: number) {
    dragStartXRef.current = clientX;
    dragDeltaXRef.current = 0;
  }

  function handleTouchMove(clientX: number) {
    if (dragStartXRef.current == null) return;
    dragDeltaXRef.current = clientX - dragStartXRef.current;
  }

  function handleTouchEnd() {
    const dragStartX = dragStartXRef.current;
    const dragDeltaX = dragDeltaXRef.current;
    if (dragStartX == null) return;
    // 从右边缘向左滑进入完整剧情设置页
    const screenW = typeof window !== "undefined" ? window.innerWidth : 400;
    if (dragStartX > screenW - 32 && dragDeltaX < -54) {
      setSettingsOpen(true);
    }
    dragStartXRef.current = null;
    dragDeltaXRef.current = 0;
  }

  // ── Long-press & context menu handlers ──
  function getClampedContextMenuPoint(clientX: number, clientY: number) {
    if (typeof window === "undefined") return { x: clientX, y: clientY };
    const menuHalfWidth = 112;
    const menuHeight = 96;
    return {
      x: Math.min(Math.max(clientX, menuHalfWidth), window.innerWidth - menuHalfWidth),
      y: Math.min(Math.max(clientY + 12, 16), window.innerHeight - menuHeight),
    };
  }

  function handleMsgPointerDown(e: React.PointerEvent, msgId: string) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button,a,input,textarea,select,summary,iframe,[data-action],[data-story-interactive]")) return;
    // Don't preventDefault — it blocks clicks on <details>, <summary>, <input> etc. inside messages
    startPosRef.current = { x: e.clientX, y: e.clientY };
    longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true;
      const point = startPosRef.current ?? { x: e.clientX, y: e.clientY };
      setContextMenuPoint(getClampedContextMenuPoint(point.x, point.y));
      setActiveMessageId(msgId);
      longPressTimerRef.current = null;
    }, 500);
  }
  function handleMsgPointerMove(e: React.PointerEvent) {
    if (!startPosRef.current) return;
    if (Math.abs(e.clientX - startPosRef.current.x) > 10 || Math.abs(e.clientY - startPosRef.current.y) > 10) {
      if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    }
  }
  function handleMsgPointerUp(e: React.PointerEvent) {
    startPosRef.current = null;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (longPressTriggeredRef.current) { e.stopPropagation(); e.preventDefault(); longPressTriggeredRef.current = false; }
  }
  function handleMsgPointerCancel() {
    startPosRef.current = null; longPressTriggeredRef.current = false;
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }

  function handleStoryDelete(msgId: string) {
    if (isGenerating || isReadOnly || mergingPageRef.current) return;
    deleteStoryMessage(msgId);
    setMessages(prev => prev.filter(m => m.id !== msgId));
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryDeleteFrom(msgId: string) {
    if (isGenerating || isReadOnly || mergingPageRef.current) return;
    deleteStoryMessagesFrom(activeSessionId, msgId);
    setMessages(prev => { const idx = prev.findIndex(m => m.id === msgId); return idx >= 0 ? prev.slice(0, idx) : prev; });
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
  }
  function handleStoryEditStart(msg: StoryMessage) {
    if (isGenerating || isReadOnly || mergingPageRef.current) return;
    setEditingMessageId(msg.id);
    setEditingContent(msg.rawContent); // 仅作为非受控 textarea 的初始值
    editingDraftRef.current = msg.rawContent;
    setActiveMessageId(null);
  }
  function handleStoryEditSave() {
    if (isGenerating || isReadOnly || mergingPageRef.current) return;
    const draft = editingDraftRef.current;
    if (!editingMessageId || !draft.trim()) { setEditingMessageId(null); setEditingContent(""); return; }
    let newRawContent = draft.trim();
    // Apply runOnEdit regex rules (placement=2, isEdit=true) to the edited content.
    try {
      const { regexes } = getStoryRenderSignature(activeCharacterId);
      if (regexes.length > 0 && messages.find(message => message.id === editingMessageId)?.kind !== "director") {
        const macroEngine = new MacroEngine(currentCharacter?.name ?? "", userIdentity?.name ?? "用户");
        newRawContent = applyEditOutputRegex(newRawContent, regexes, { macroEngine, activeTags: ["story"] });
      }
    } catch {
      // If regex resolution fails, proceed with unmodified content
    }
    editStoryMessage(editingMessageId, newRawContent);
    setMessages(prev => prev.map(m => m.id === editingMessageId
      ? { ...m, rawContent: newRawContent, storySummary: undefined, renderedContent: undefined, regexSignature: undefined, parserVersion: undefined }
      : m
    ));
    setEditingMessageId(null);
    setEditingContent("");
    setStorageVersion(v => v + 1);
  }
  function handleStoryCopy(text: string) {
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
      document.body.appendChild(ta); ta.focus(); ta.select();
      try { document.execCommand("copy"); } catch {}
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).catch(fallbackCopy); }
    else { fallbackCopy(); }
    setActiveMessageId(null);
  }
  async function handleStoryRetry(msgId: string, retryInstruction = "") {
    if (isGenerating || isReadOnly || mergingPageRef.current) return;
    const msgIndex = messages.findIndex(m => m.id === msgId);
    if (msgIndex === -1) return;
    const retryMessage = messages[msgIndex];
    if (retryMessage.role !== "assistant" && retryMessage.role !== "user") return;
    const sessionId = activeSessionId;
    const characterId = activeCharacterId;
    const contextMessages = getStoryRetryContext(messages, msgId);
    if (!contextMessages) return;
    setActiveMessageId(null);
    setStorageVersion(v => v + 1);
    // 请求期间保留旧文，先贴底显示生成指示器；成功后再替换历史。
    autoBottomLockRef.current = true;
    requestAnimationFrame(() => scrollStoryToBottom());
    markGenerating(sessionId, true);
    const generationRun = createStoryGenerationRun(sessionId);
    const generationRunId = generationRun.runId;
    const isCurrentGeneration = () => isStoryGenerationRunActive(sessionId, generationRunId);
    try {
      const result = await generateStoryCompletion(characterId, contextMessages, {
        sessionId,
        retryInstruction,
        sessionFoldTags: currentSession?.foldTags,
        sessionContextExcludedTags: currentSession?.contextExcludedTags,
        settings: currentSession?.settings,
        globalSettings: storyGlobalSettings,
        floatingChatContext: currentSession?.independentStory ? "" : floatingChatContext,
        participantIds: currentSession?.participantIds || [characterId],
        storyMemory: {
          independent: currentSession?.independentStory,
          inheritRecentMemory: currentSession?.inheritRecentMemory ?? true,
          startedAt: currentSession?.createdAt,
        },
        onDelta: storyGlobalSettings.streamingEnabled ? (delta) => appendStoryStreamDelta(sessionId, delta) : undefined,
        signal: generationRun.controller.signal,
      });
      if (!isCurrentGeneration()) return;
      replaceStoryMessages(sessionId, contextMessages);
      const assistantMessage = pushStoryMessage({
        sessionId, role: "assistant",
        rawContent: result.rawText, renderedContent: result.renderedText,
        storySummary: result.storySummary, regexSignature: result.regexSignature, parserVersion: result.parserVersion,
      });
      refreshGenerationView(sessionId);
    } catch (error) {
      if (!isCurrentGeneration() || isAbortLikeError(error)) return;
      const errText = error instanceof Error ? error.message : "重试失败，请稍后再试。";
      const systemMessage = pushStoryMessage({ sessionId, role: "system", rawContent: errText, renderedContent: errText });
      refreshGenerationView(sessionId);
    } finally {
      clearStoryStream(sessionId);
      if (finishStoryGenerationRun(sessionId, generationRunId)) {
        markGenerating(sessionId, false);
      }
    }
  }

  // 快捷输入面板：选项与光标位置来自公用仓库中当前角色选中的方案；选项全空时回落默认符号
  const activeQuickInputScheme = resolveActiveQuickInputScheme(uiPrefs, schemeRepo);
  const quickInputOptionsRaw = activeQuickInputScheme.options.filter((item) => item.trim());
  const quickInputOptions = quickInputOptionsRaw.length > 0 ? quickInputOptionsRaw : STORY_DEFAULT_QUICK_INPUT_OPTIONS;
  const quickInputCursor = activeQuickInputScheme.cursor ?? "middle";

  if (!ready) return null;

  if (characters.length === 0) {
    return (
      <div className="story-app-shell" data-story-theme="paper">
        <div className="story-shell-inner">
          <div className="story-header">
            <div className="story-header-safe-area" />
            <div className="story-header-content">
              <div className="story-header-left">
                <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                  <SolidBackIcon size={16} />
                </button>
              </div>
              <div className="story-header-center" />
              <div className="story-header-right" />
            </div>
          </div>

          <div className="story-stage story-stage-empty">
            <div className="story-stage-inner">
              <div className="story-empty story-empty-panel">
                <BookOpenIcon width={30} height={30} opacity={0.45} />
                <div>
                  <div className="story-empty-title">还没有角色卡</div>
                  <div className="story-empty-desc">请先创建或导入角色卡，再进入剧情 APP 开始故事。</div>
                </div>
                <button className="story-empty-action" onClick={onClose}>
                  返回
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!currentCharacter || !currentSession) return null;

  const sessionScope = `.story-session-${currentSession.id}`;

  if (settingsOpen) {
    return (
      <div className={`story-app-shell story-session-${currentSession.id}`} data-story-theme={uiPrefs.theme || "paper"} style={storyShellStyle}>
        {customFontFace ? <style>{customFontFace}</style> : null}
        <StorySettingsPage
          characters={characters}
          activeCharacterId={activeCharacterId}
          activeGroupId={activeGroupId}
          groups={storyGroups}
          ownerSessions={ownerSessions}
          activeSessionId={activeSessionId}
          userName={userIdentity?.name || "用户"}
          uiPrefs={uiPrefs}
          settings={storySettings}
          globalSettings={storyGlobalSettings}
          schemeRepo={schemeRepo}
          boundPreset={boundPreset}
          foldTags={foldTagsDraft}
          contextExcludedTags={contextExcludedTagsDraft}
          customCSS={currentSession.customCSS || ""}
          onClose={() => setSettingsOpen(false)}
          onCharacterChange={handleStoryCharacterChange}
          onGroupSelect={handleStoryGroupSelect}
          onGroupCreate={handleStoryGroupCreate}
          onGroupRename={(groupId, name) => {
            updateStoryGroup(groupId, { name });
            setStorageVersion((value) => value + 1);
          }}
          onGroupDelete={handleStoryGroupDelete}
          onSessionSelect={handleStorySessionSelect}
          onBranchCreate={handleStoryBranchCreate}
          onBranchDelete={handleStoryBranchDelete}
          onBranchMerge={(sessionId) => { void handleStoryBranchMerge(sessionId); }}
          mergeBusy={mergingPage || generatingSessionIds.size > 0}
          onSessionUpdate={handleStorySessionUpdate}
          onExportSession={handleExportStorySession}
          onExportSessions={handleExportSelectedStories}
          onExportAll={handleExportAllStories}
          onMergeBranches={handleMergeStoryBranches}
          onUiPrefsChange={(next) => applySessionUpdates({ uiPrefs: next })}
          onSettingsChange={(next) => applySessionUpdates({ settings: next })}
          onGlobalSettingsChange={(next) => {
            saveStoryGlobalSettings(next);
            setStoryGlobalSettings(next);
          }}
          onSchemeRepoChange={saveStorySchemeRepository}
          onTagsChange={(foldTags, contextExcludedTags) => {
            setFoldTagsDraft(foldTags);
            setContextExcludedTagsDraft(contextExcludedTags);
            applySessionUpdates({ foldTags: foldTags.trim(), contextExcludedTags: contextExcludedTags.trim() });
          }}
          onCustomCSSChange={(css) => {
            setCustomCssDraft(css);
            applySessionUpdates({ customCSS: css });
          }}
          onOpenCss={() => {
            setSettingsOpen(false);
            setCssModalOpen(true);
          }}
          onRebuildCache={() => {
            try {
              const rebuilt = rebuildStorySessionRenderCache(activeCharacterId, currentSession.id, { sessionFoldTags: currentSession.foldTags });
              setMessages(rebuilt);
              setStorageVersion((value) => value + 1);
              alert(`缓存重建完成，${rebuilt.length} 条消息已更新`);
            } catch (error) {
              alert(error instanceof Error ? error.message : "缓存重建失败，请检查 API 绑定配置");
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`story-app-shell story-session-${currentSession.id}`}
      data-story-theme={uiPrefs.theme || "paper"}
      style={storyShellStyle}
      onTouchStart={(event) => handleTouchStart(event.touches[0]?.clientX || 0)}
      onTouchMove={(event) => handleTouchMove(event.touches[0]?.clientX || 0)}
      onTouchEnd={handleTouchEnd}
      onMouseDown={(event) => handleTouchStart(event.clientX)}
      onMouseMove={(event) => {
        if (dragStartXRef.current != null) handleTouchMove(event.clientX);
      }}
      onMouseUp={handleTouchEnd}
      onMouseLeave={handleTouchEnd}
    >
      {/* Styles moved to styles/story.css */}
      {customFontFace ? <style>{customFontFace}</style> : null}
      {uiPrefs.wallpaper ? <div className="story-wallpaper-layer" style={{ backgroundImage: `url(${uiPrefs.wallpaper})` }} /> : null}
      {currentSession.customCSS ? (
        <SessionCustomCSS css={currentSession.customCSS} scope={sessionScope} />
      ) : null}

      <div className="story-shell-inner" ref={shellInnerRef}>

        {/* ====== 固定顶部标题栏 ====== */}
        <div className="story-header">
          <div className="story-header-safe-area" />
          <div className="story-header-content">
            <div className="story-header-left">
              <button className="story-top-btn" onClick={onClose} aria-label="关闭剧情模式">
                <SolidBackIcon size={16} />
              </button>
              <div className="story-header-person">
                <Avatar src={storyAvatar || undefined} name={storyDisplayName} size="sm" />
                <span>{storyDisplayName}</span>
              </div>
            </div>
            <div className="story-header-center" />
            <div className="story-header-right" style={{ gap: 8 }}>
              <button className="story-top-btn" onClick={() => setQuickStoryOpen(true)} aria-label="快捷进入新剧情">
                <PlusIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={() => setCssModalOpen(true)} aria-label="页面样式">
                <PaintBrushIcon width={16} height={16} />
              </button>
              <button className="story-top-btn" onClick={() => setSettingsOpen(true)} aria-label="打开剧情设置">
                <SolidMenuIcon size={16} />
              </button>
            </div>
          </div>
        </div>

        <div
          className="story-stage"
          ref={scrollRef}
          onScroll={(event) => {
            const node = event.currentTarget;
            stageScrollMemoRef.current = node.scrollTop; // 持续记录，供设置页返回时恢复
            if (performance.now() < foldToggleSuppressUntilRef.current) return;
            const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
            autoBottomLockRef.current = distanceFromBottom <= 12;
          }}
        >
          <div className="story-stage-inner">
            
            {/* ====== 顶部信息阅读卡片 ====== */}
            <div className="story-meta">
              <div className="story-meta-layout">
                <div className="story-meta-cover">
                  {storyAvatar ? (
                    <img src={storyAvatar} alt="cover" />
                  ) : (
                    <div className="story-meta-cover-fallback" aria-hidden="true">
                      <span className="story-meta-cover-char">{storyDisplayName.trim().charAt(0) || "书"}</span>
                      <span className="story-meta-cover-line" />
                      <span className="story-meta-cover-sub">STORY</span>
                    </div>
                  )}
                </div>
                <div className="story-meta-body">
                  <div className="story-meta-title">本次阅读：《 {storyDisplayName} 》</div>
                  <div className="story-meta-tags">
                    {userIdentity?.name || "我"} x {storyDisplayName}
                  </div>
                  <div className="story-meta-desc">
                    {/* Character type might not have description, so we use a stylized default text */}
                    “有些故事，在开始之前就已经写好了结局。”
                  </div>
                </div>
              </div>
            </div>

            {messages.length === 0 ? (
              <div className="story-empty">
                <BookOpenIcon width={28} height={28} opacity={0.45} />
                <div>
                  <div className="text-[calc(14px*var(--app-text-scale,1))] font-medium text-[var(--c-story-heading,#1e293b)] mb-1">故事从这里开始</div>
                  <div className="text-[calc(12px*var(--app-text-scale,1))] opacity-70">从底部输入一段引导，剧情会继续展开。</div>
                </div>
              </div>
            ) : (
              <>
                {hasMoreMessages ? (
                  <button
                    type="button"
                    className="story-load-more-btn"
                    onClick={loadMoreMessages}
                  >
                    <span>查看更多消息</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="18 15 12 9 6 15" />
                    </svg>
                  </button>
                ) : null}
                {visibleMessages.map((message) => {
                  const speakerName = message.kind === "director" ? "导演指令" : message.role === "user"
                    ? (userIdentity?.name?.trim() || "我")
                    : message.role === "assistant"
                      ? storyDisplayName
                      : "系统";
                  const avatarUrl = message.role === "user"
                    ? (userIdentity?.avatarUrl || undefined)
                    : message.role === "assistant"
                      ? (storyAvatar || undefined)
                      : undefined;
                  return (
                    <article
                      key={message.id}
                      className="story-row"
                      data-role={message.role}
                      data-story-message-id={message.id}
                      onPointerDown={(e) => handleMsgPointerDown(e, message.id)}
                      onPointerMove={handleMsgPointerMove}
                      onPointerUp={handleMsgPointerUp}
                      onPointerCancel={handleMsgPointerCancel}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setContextMenuPoint(getClampedContextMenuPoint(e.clientX, e.clientY));
                        setActiveMessageId(message.id);
                      }}
                    >
                      {message.role !== "system" ? (
                        <div className="story-msg-head">
                          <div className="story-avatar-wrap">
                            <Avatar src={avatarUrl} name={speakerName} size="md" />
                          </div>
                          <div className="story-msg-meta">
                            <span className="story-msg-name">{speakerName}</span>
                            <span className="story-msg-time">{formatStoryTime(message.createdAt)}</span>
                          </div>
                        </div>
                      ) : null}
                      <div className="story-bubble-wrap" style={{ position: "relative" }}>
                        <div className="story-bubble">
                          {editingMessageId === message.id ? (
                            <div className="story-inline-edit">
                              <div className="story-grow-wrap" data-value={editingContent}>
                                <textarea
                                  autoFocus
                                  defaultValue={editingContent}
                                  onInput={(e) => {
                                    const el = e.currentTarget;
                                    editingDraftRef.current = el.value;
                                    const wrap = el.parentElement;
                                    if (wrap) wrap.dataset.value = el.value;
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handleStoryEditSave(); }
                                    if (e.key === "Escape") { setEditingMessageId(null); setEditingContent(""); }
                                  }}
                                />
                              </div>
                              <div className="story-inline-edit-actions">
                                <button onClick={() => { setEditingMessageId(null); setEditingContent(""); }} className="story-inline-edit-btn">取消</button>
                                <button onClick={handleStoryEditSave} className="story-inline-edit-btn story-inline-edit-btn-save">保存</button>
                              </div>
                            </div>
                          ) : message.kind === "director" ? <StoryDirectorNote text={message.rawContent} /> : (
                            <StoryHtmlRenderer
                              content={message.renderedContent || message.rawContent}
                              messageId={message.id}
                              onOptionSelect={handleOptionSelect}
                              onVoicePlay={message.role === "assistant" ? handleStoryVoicePlay : undefined}
                              playingVoiceSegmentId={playingVoiceSegmentId}
                              statusRenderHtml={activeStatusRenderHtml}
                              theaterRenderHtml={activeTheaterRenderHtml}
                              serifIframeFallback
                            />
                          )}
                        </div>
                        {activeMessageId === message.id && (() => {
                          const menu = (
                            <div
                              className="story-ctx-menu"
                              style={contextMenuPoint ? { left: contextMenuPoint.x, top: contextMenuPoint.y } : undefined}
                              onPointerDown={(e) => e.stopPropagation()}
                            >
                              <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryCopy(message.rawContent)} className="story-ctx-btn">复制</button>
                                {!isReadOnly && <button onClick={() => handleStoryEditStart(message)} className="story-ctx-btn">编辑</button>}
                                {!isReadOnly && (message.role === "assistant" || message.role === "user") && (
                                  <button disabled={isGenerating} onClick={() => {
                                    setActiveMessageId(null);
                                    const context = getStoryRetryContext(messages, message.id);
                                    setActionRequest({ mode: "retry", messageId: message.id, discardsFollowing: !!context && messages.slice(context.length).length > 1 });
                                  }} className="story-ctx-btn story-ctx-btn-danger">重试</button>
                                )}
                              </div>
                              {!isReadOnly && <div style={{ display: "flex" }}>
                                <button onClick={() => handleStoryDelete(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除</button>
                                <button onClick={() => handleStoryDeleteFrom(message.id)} className="story-ctx-btn story-ctx-btn-danger">删除以下</button>
                              </div>}
                              <div className="story-ctx-triangle" />
                            </div>
                          );
                          return shellInnerRef.current ? createPortal(menu, shellInnerRef.current) : menu;
                        })()}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {isGenerating && activeStreamingText ? (
              <article className="story-row story-streaming-row" data-role="assistant" aria-live="polite">
                <div className="story-msg-head">
                  <div className="story-avatar-wrap"><Avatar src={storyAvatar || undefined} name={storyDisplayName} size="md" /></div>
                  <div className="story-msg-meta"><span className="story-msg-name">{storyDisplayName}</span><span className="story-msg-time">正在输出</span></div>
                </div>
                <div className="story-bubble-wrap"><div className="story-bubble"><div className="story-streaming-text">{activeStreamingText}<span className="story-streaming-cursor" aria-hidden="true" /></div></div></div>
              </article>
            ) : null}
            {isGenerating && !activeStreamingText ? (
              <StoryGeneratingIndicator
                characterName={storyDisplayName}
                avatar={storyAvatar || undefined}
              />
            ) : null}
          </div>
        </div>
      </div>

      {voiceNotice ? (
        <div className="story-voice-notice" role="status">{voiceNotice}</div>
      ) : null}

      {isReadOnly ? (
        <div className="story-archive-notice" role="status">
          <span>已并入主线 · 此页只读，内容随主线对应记录同步</span>
          <button type="button" className="story-load-more-btn" onClick={() => handleStorySessionSelect((currentSession.mergedIntoSessionId || currentSession.mergedIntoMainSessionId)!)}>前往主线继续</button>
        </div>
      ) : <StoryComposer
        key={activeSessionId}
        isGenerating={isGenerating}
        appendRequest={composerAppendRequest}
        voiceEnabled={Boolean(uiPrefs.voiceEnabled)}
        voicePlaying={Boolean(playingVoiceSegmentId)}
        voiceProgress={voiceSequenceProgress}
        onSend={(text) => { void handleSend(text); }}
        onContinue={() => { void handleSend("继续"); }}
        autoReadingEnabled={Boolean(uiPrefs.autoReadingEnabled)}
        autoReading={autoReading}
        currentReadExpanded={currentReadExpanded}
        canAutoRead={messages.length > 0}
        onToggleAutoReading={() => {
          if (autoReading) setAutoReading(false);
          else startAutoReading("latest");
        }}
        onCurrentReadControl={() => {
          if (!currentReadExpanded) setCurrentReadExpanded(true);
          else startAutoReading("current");
        }}
        onStop={handleStopGeneration}
        tools={<StoryActions busy={isGenerating}
          retryTarget={[...messages].reverse().find(message => message.role === "user" || message.role === "assistant")?.id}
          request={actionRequest} onRequest={setActionRequest}
          onSubmit={(request, instruction) => {
            setActionRequest(null);
            if (request.mode === "director") void handleSend(instruction, "director");
            else void handleStoryRetry(request.messageId, instruction);
          }} />}
        onPlayNext={() => { void handlePlayNextStoryVoice(); }}
        quickInputEnabled={Boolean(uiPrefs.quickInputEnabled)}
        quickInputOptions={quickInputOptions}
        quickInputCursor={quickInputCursor}
      />}

      {!isReadOnly && storySettings.floatingPhoneEnabled ? (
        <button className="story-floating-phone-ball" type="button" onClick={() => { setFloatingChatVersion((value) => value + 1); setFloatingPhoneTab("chat"); setFloatingPlusOpen(false); setFloatingPhoneOpen(true); }} aria-label="打开悬浮小手机"><MiniPhoneIcon size={18} /></button>
      ) : null}
      {floatingPhoneOpen ? (
        <div className="story-mini-phone-overlay" onClick={() => setFloatingPhoneOpen(false)}>
          {!independentFloatingShell ? (
            <section className="story-floating-chat-app" onClick={(event) => event.stopPropagation()}>
              <PhoneChatApp
                onClose={() => setFloatingPhoneOpen(false)}
                initialSessionId={floatingChatSession?.id || null}
                onUserMessageSent={appendEmbeddedChatTrace}
                onMomentPublished={handleFloatingMomentPublished}
              />
            </section>
          ) : (
          <>
          <section className="story-mini-phone" onClick={(event) => event.stopPropagation()}>
            {floatingPhoneTab === "moments" && !independentFloatingShell ? (
              <div className="story-mini-phone-moments">
                <MomentsFeed compact onCloseApp={() => setFloatingPhoneTab("chat")} onUserPublished={handleFloatingMomentPublished} />
              </div>
            ) : (
              <>
                <header className="story-mini-phone-header">
                  <button type="button" onClick={() => floatingPhoneTab === "moments" ? setFloatingPhoneTab("chat") : setFloatingPhoneOpen(false)} aria-label={floatingPhoneTab === "moments" ? "返回聊天" : "关闭小手机"}><XMarkIcon width={15} /></button>
                  <div className="story-mini-phone-identity"><Avatar src={storyAvatar || undefined} name={storyDisplayName} size="sm" /><strong>{independentFloatingShell ? storyDisplayName : activeGroup ? (floatingChatSession?.groupName || storyDisplayName) : currentCharacter.name}</strong></div>
                  <button className="story-mini-phone-moments-btn" type="button" onClick={() => { setFloatingPlusOpen(false); setFloatingPhoneTab("moments"); }} aria-label="打开动态" title="动态">
                    <span aria-hidden="true">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="4" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <path d="m21 15-5-5L5 21" />
                      </svg>
                    </span><small>动态</small>
                  </button>
                </header>

                {floatingPhoneTab === "moments" ? (
                  <div className="story-mini-phone-isolated-moments">
                    <div className="story-mini-phone-local-title">
                      <div><strong>剧情朋友圈</strong><small>仅保留在当前独立剧情</small></div>
                      <button type="button" onClick={() => setIsolatedMomentComposerOpen(true)}>发布</button>
                    </div>
                    <div className="story-mini-phone-local-feed">
                      {isolatedPhoneTraces.filter((message) => message.rawContent.startsWith("【剧情朋友圈")).length ? isolatedPhoneTraces.filter((message) => message.rawContent.startsWith("【剧情朋友圈")).reverse().map((message) => (
                        <article key={message.id}><Avatar src={userIdentity?.avatarUrl} name={userIdentity?.name || "用户"} size="sm" /><div><strong>{userIdentity?.name || "用户"}</strong><p>{message.rawContent.split("\n").slice(1).join("\n")}</p><small>{formatStoryTime(message.createdAt)}</small></div></article>
                      )) : <p className="story-mini-phone-empty">还没有本剧情朋友圈</p>}
                    </div>
                    {isolatedMomentComposerOpen ? (
                      <div className="story-mini-phone-local-compose">
                        <textarea value={isolatedMomentDraft} onChange={(event) => setIsolatedMomentDraft(event.target.value)} placeholder="这一刻的想法…" autoFocus />
                        <div><button type="button" onClick={() => setIsolatedMomentComposerOpen(false)}>取消</button><button type="button" disabled={!isolatedMomentDraft.trim()} onClick={publishIsolatedMoment}>发表</button></div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {!independentFloatingShell && activeGroup ? (
                      floatingGroupChatCandidates.length ? (
                        <label className="story-mini-phone-group-select"><span>悬浮小手机群聊</span><select value={floatingChatSession?.id || ""} onChange={(event) => setFloatingGroupSessionId(event.target.value)}>{floatingGroupChatCandidates.map((item) => <option key={item.id} value={item.id}>{item.groupName || "未命名群聊"}</option>)}</select></label>
                      ) : <p className="story-mini-phone-group-empty">若没有群聊建议先建一个群聊</p>
                    ) : null}
                    <div className="story-mini-phone-messages" ref={miniPhoneScrollRef}>
                      {independentFloatingShell ? (
                        isolatedPhoneTraces.length ? isolatedPhoneTraces.map((message) => (
                          <div key={message.id} data-role="user"><small>{formatStoryTime(message.createdAt)}</small><p>{message.rawContent.split("\n").slice(1).join("\n")}</p></div>
                        )) : <div className="story-mini-phone-isolated"><MiniPhoneIcon size={28} /><strong>独立剧情小手机</strong><p>不绑定、读取或同步线上聊天；这里的操作只会成为当前剧情痕迹。</p></div>
                      ) : floatingChatMessages.length ? floatingChatMessages.map((message) => (
                        <div key={message.id} data-role={message.role}>
                          <small>{message.role === "user" ? (userIdentity?.name || "我") : (message.senderName || currentCharacter.name)} · {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
                          <p>{message.content || message.mediaData?.label || (message.mediaType ? `[${message.mediaType}]` : "")}</p>
                        </div>
                      )) : <p className="story-mini-phone-empty">{activeGroup && !floatingChatSession ? "若没有群聊建议先建一个群聊" : "还没有线上聊天记录"}</p>}
                      {floatingChatGenerating ? <div className="story-mini-phone-typing"><i /><i /><i /></div> : null}
                    </div>
                    {floatingPlusOpen ? (
                      <div className="chat-plus-menu story-mini-phone-plus-panel">
                        <button className="chat-plus-menu-item" type="button" onClick={() => openFloatingRichPanel("voice")}>
                          <span className="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" /></svg></span>
                          <span>语音条</span>
                        </button>
                        <button className="chat-plus-menu-item" type="button" onClick={() => openFloatingRichPanel("image")}>
                          <span className="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" /></svg></span>
                          <span>照片墙</span>
                        </button>
                        <button className="chat-plus-menu-item" type="button" onClick={() => openFloatingRichPanel(activeGroup ? "transfer_target" : "transfer")}>
                          <span className="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><text x="12" y="16" textAnchor="middle" fontSize="12" fill="currentColor" stroke="none">¥</text></svg></span>
                          <span>转账</span>
                        </button>
                        <button className="chat-plus-menu-item" type="button" onClick={() => openFloatingRichPanel("location")}>
                          <span className="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" /></svg></span>
                          <span>位置</span>
                        </button>
                        <button className="chat-plus-menu-item" type="button" onClick={() => openFloatingRichPanel("gift")}>
                          <span className="chat-plus-icon-box"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="8" width="18" height="13" rx="2" /><path d="M12 8v13M3 12h18M7.5 8C5 8 4 6.8 4 5.5S5 3 6.5 3C9 3 12 8 12 8s3-5 5.5-5C19 3 20 4.2 20 5.5S19 8 16.5 8" /></svg></span>
                          <span>礼物</span>
                        </button>
                      </div>
                    ) : null}
                    <div className="story-mini-phone-composer">
                      <button className="story-mini-phone-plus-btn" type="button" onClick={() => setFloatingPlusOpen((value) => !value)} aria-label="更多功能"><PlusIcon width={14} /></button>
                      <textarea
                        rows={1}
                        value={floatingChatDraft}
                        onChange={(event) => setFloatingChatDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void handleFloatingChatSend();
                          }
                        }}
                        placeholder={independentFloatingShell ? "输入只写入本剧情…" : activeGroup && !floatingChatSession ? "若没有群聊建议先建一个群聊" : "发消息…"}
                        disabled={floatingChatGenerating || Boolean(!independentFloatingShell && activeGroup && !floatingChatSession)}
                      />
                      <button type="button" onClick={() => { void handleFloatingChatSend(); }} disabled={!floatingChatDraft.trim() || floatingChatGenerating || Boolean(!independentFloatingShell && activeGroup && !floatingChatSession)} aria-label="发送消息">
                        {floatingChatGenerating ? <span>···</span> : <PaperAirplaneIcon width={14} />}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </section>

          {floatingRichKind ? (
            <div className="story-mini-phone-modal-layer" onClick={(event) => event.stopPropagation()}>
              {floatingRichKind === "voice" ? <VoiceRecordModal characterId={activeCharacterId} onClose={() => setFloatingRichKind(null)} onSend={(text, audioDataUrl) => { void handleFloatingRichSend("audio", { label: text }, `发送了一条语音：${text}`, audioDataUrl); }} /> : null}
              {floatingRichKind === "image" ? <PhotoInputModal onClose={() => setFloatingRichKind(null)} onSend={(description, imageDataUrl) => { void handleFloatingRichSend("image", { label: description || "图片" }, `发送了一张图片${description ? `：${description}` : ""}`, imageDataUrl); }} /> : null}
              {floatingRichKind === "transfer_target" ? <TransferTargetModal participants={activeGroupCharacters} onClose={() => setFloatingRichKind(null)} onSelect={(character) => { setFloatingTransferTargetId(character.id); setFloatingRichKind("transfer"); }} /> : null}
              {floatingRichKind === "transfer" ? <RedPacketModal mode="transfer" onClose={() => { setFloatingRichKind(null); setFloatingTransferTargetId(""); }} onSend={(amount, label) => {
                const target = activeGroupCharacters.find((character) => character.id === floatingTransferTargetId);
                void handleFloatingRichSend("transfer", { amount, label, status: "pending", ...(target ? { recipientId: target.id, recipientName: target.name } : {}) }, `向${target?.name || currentCharacter?.name || "对方"}转账 ¥${amount.toFixed(2)}${label ? `（${label}）` : ""}`);
              }} /> : null}
              {floatingRichKind === "location" ? <LocationInputModal onClose={() => setFloatingRichKind(null)} onSend={(location) => { void handleFloatingRichSend("location", { label: location }, `分享了位置：${location}`); }} /> : null}
              {floatingRichKind === "gift" ? <GiftPickerModal gifts={floatingGiftCandidates} isGroup={Boolean(activeGroup)} recipients={activeGroupCharacters} onClose={() => setFloatingRichKind(null)} onSend={(gift: ShoppingGiftCandidate, recipient) => {
                void handleFloatingRichSend("gift", {
                  label: gift.productName, giftName: gift.productName, shoppingGiftId: gift.id, giftOrderId: gift.orderId,
                  giftItemId: gift.itemId, giftMerchantLabel: gift.merchantLabel, giftPriceLabel: gift.priceLabel,
                  giftPreviewIcon: gift.previewIcon, giftTone: gift.tone, giftDeliveredAt: gift.deliveredAt,
                  giftSentAt: new Date().toISOString(), senderName: userIdentity?.name || "用户",
                  ...(recipient ? { recipientId: recipient.id, recipientName: recipient.name } : {}),
                }, `向${recipient?.name || currentCharacter?.name || "对方"}送出礼物：${gift.productName}`);
              }} /> : null}
            </div>
          ) : null}
          </>
          )}
        </div>
      ) : null}

      {quickStoryOpen ? (
        <div className="story-dialog-backdrop story-quick-story-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setQuickStoryOpen(false);
        }}>
          <section className="story-dialog story-quick-story-dialog" role="dialog" aria-modal="true" aria-label="快捷进入新剧情">
            <header><strong>快捷进入新剧情</strong><button type="button" onClick={() => setQuickStoryOpen(false)}><XMarkIcon width={16} /></button></header>
            <p className="story-quick-story-question">是否结束当前剧情，快捷进入新剧情？</p>
            <p className="story-settings-note">新分线会按当前时间自动命名，之后可在剧情目录中修改。</p>
            <label className="story-settings-toggle-row">
              <span><strong>独立剧情分线</strong></span>
              <input type="checkbox" checked={quickStoryIndependent} onChange={(event) => setQuickStoryIndependent(event.target.checked)} />
            </label>
            <footer><button type="button" onClick={() => setQuickStoryOpen(false)}>取消</button><button type="button" className="story-settings-primary" onClick={handleQuickStoryCreate}>结束并新建</button></footer>
          </section>
        </div>
      ) : null}

      {/* CSS Style Modal */}
      {cssModalOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 300,
          background: "var(--c-story-bg-top, #fdfdfd)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "52px 20px 14px",
            borderBottom: "1px solid rgba(0,0,0,0.04)",
          }}>
            <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.08em", textTransform: "uppercase" as const, fontWeight: 500, color: "var(--c-story-sub, #94a3b8)" }}>
              页面样式
            </span>
            <button className="story-top-btn" onClick={() => setCssModalOpen(false)}>
              <XMarkIcon width={17} height={17} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 8 }}>
                {STORY_THEMES.map(t => {
                  const active = (uiPrefs.theme || "paper") === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-label={`切换到${t.name}主题`}
                      aria-pressed={active}
                      onClick={() => applySessionUpdates({ uiPrefs: { ...uiPrefs, theme: t.id } })}
                      style={{
                        minHeight: 54,
                        borderRadius: 0,
                        border: "none",
                        boxShadow: "none",
                        background: active ? "var(--c-story-panel-active, rgba(148,163,184,0.12))" : "var(--c-story-panel, rgba(255,255,255,0.5))",
                        color: "var(--c-story-text, #3a3b3c)",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 5,
                        padding: "7px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <span style={{
                        width: 22,
                        height: 22,
                        borderRadius: "50%",
                        background: t.color,
                        border: "none",
                        boxShadow: active
                          ? "inset 0 0 0 2px var(--c-story-bg-top, #fdfdfd), 0 0 0 2px var(--c-story-text, #3a3b3c)"
                          : "none",
                      }} />
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-story-sub, #94a3b8)", lineHeight: 1.1 }}>{t.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <textarea
              className="story-css-box"
              value={customCssDraft}
              onChange={(event) => setCustomCssDraft(event.target.value)}
              placeholder={`/* 这里写剧情模式的 session CSS */\n.story-bubble { border-radius: 30px; }\n.story-composer { backdrop-filter: blur(24px); }`}
              style={{ flex: 1, minHeight: 280 }}
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CSSSchemeBar target="story" currentCSS={customCssDraft} onLoad={setCustomCssDraft} btnStyle={{
                border: "none",
                borderRadius: 0,
                boxShadow: "none",
                background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))",
                color: "var(--c-story-text, #3a3b3c)",
              }} modalVars={{
                panel: "var(--c-story-drawer-top, #fdfdfd)",
                border: "var(--c-story-drawer-border, rgba(0,0,0,0.06))",
                text: "var(--c-story-text, #3a3b3c)",
                textDim: "var(--c-story-sub, #94a3b8)",
                input: "var(--c-story-css-box-bg, rgba(248,250,252,0.6))",
                inputBorder: "var(--c-story-panel-border, rgba(0,0,0,0.06))",
                accent: "var(--c-story-send-bg-active, #0f172a)",
              }} />
              <button
                onClick={() => setCustomCssDraft(CSS_EXAMPLE)}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                加载示例
              </button>
              <button
                onClick={() => setCustomCssDraft("")}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0,
                  border: "none", boxShadow: "none",
                  background: "var(--c-story-btn-bg, rgba(255,255,255,0.5))", color: "var(--c-story-text, #3a3b3c)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                清除
              </button>
              <button
                onClick={() => { applySessionUpdates({ customCSS: customCssDraft }); setCssModalOpen(false); }}
                style={{
                  flex: 1, padding: "12px 0", borderRadius: 0, border: "none", boxShadow: "none",
                  background: "var(--c-story-send-bg-active, #dbe3ea)", color: "var(--c-story-send-color-active, #475569)",
                  fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer",
                }}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
