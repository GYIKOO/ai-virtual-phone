"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowPathIcon, FilmIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/solid";
import "./story-actions.css";

export type StoryActionRequest = { mode: "director" } | { mode: "retry"; messageId: string; discardsFollowing?: boolean };

export function StoryDirectorNote({ text }: { text: string }) {
  return <details className="story-director-note">
    <summary><FilmIcon width={14} height={14} />导演指令<span>点击查看</span></summary>
    <p>{text}</p>
    <small>只指导对应的一次生成，不作为剧情事件。</small>
  </details>;
}

/** Shared by the real composer and the development-only, API-free preview. */
export function StoryActions({ busy, retryTarget, request, onRequest, onSubmit }: {
  busy: boolean;
  retryTarget?: string;
  request: StoryActionRequest | null;
  onRequest: (request: StoryActionRequest | null) => void;
  onSubmit: (request: StoryActionRequest, instruction: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const id = useId();

  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setExpanded(false); buttonRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [expanded]);

  useEffect(() => {
    setExpanded(false);
    setDraft("");
    const dialog = dialogRef.current;
    if (!request || !dialog) return;
    dialog.showModal();
    inputRef.current?.focus();
    return () => { dialog.close(); buttonRef.current?.focus(); };
  }, [request]);

  useEffect(() => { if (busy) setExpanded(false); }, [busy]);

  const close = () => onRequest(null);
  const submit = () => {
    if (!request || busy || (request.mode === "director" && !draft.trim())) return;
    onSubmit(request, draft.trim());
  };
  const retry = request?.mode === "retry";
  return <>
    <div className="story-actions" ref={rootRef}>
      <button ref={buttonRef} type="button" className="story-actions-toggle" aria-label="剧情工具"
        aria-expanded={expanded} aria-controls={`${id}-menu`} disabled={busy}
        onClick={() => setExpanded(value => !value)}>
        <PlusIcon width={20} height={20} style={{ transform: expanded ? "rotate(45deg)" : undefined }} />
      </button>
      {expanded && <div id={`${id}-menu`} className="story-actions-popover" aria-label="剧情工具选项">
        <button type="button" onClick={() => onRequest({ mode: "director" })}>
          <FilmIcon width={18} height={18} /><span>导演指令<small>指导接下来的一段剧情</small></span>
        </button>
        <button type="button" disabled={!retryTarget} onClick={() => retryTarget && onRequest({ mode: "retry", messageId: retryTarget })}>
          <ArrowPathIcon width={18} height={18} /><span>重试上一段<small>可附加要求，也可直接重试</small></span>
        </button>
      </div>}
    </div>
    {request && typeof document !== "undefined" && createPortal(
      <dialog ref={dialogRef} className="story-instruction-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}
        onCancel={event => { event.preventDefault(); close(); }}>
        <div className="story-instruction-heading">
          <div><span className="story-instruction-eyebrow">剧情工具</span><h2 id={`${id}-title`}>{retry ? "重试这一段" : "导演指令"}</h2></div>
          <button type="button" aria-label="关闭剧情指令" onClick={close}><XMarkIcon width={21} height={21} /></button>
        </div>
        <p id={`${id}-hint`}>{retry ? "可以指出原稿问题，也可以提出新的剧情方向。仅用于这次重试，不会保存到剧情记录。留空可直接重试。" : "用创作指令指导下一段，不会被当作你的角色对白。记录中默认折叠显示。"}</p>
        <label htmlFor={`${id}-input`}>{retry ? "希望这一段如何调整？（可选）" : "希望接下来的剧情如何发展？"}</label>
        <textarea id={`${id}-input`} ref={inputRef} rows={5} value={draft} onChange={event => setDraft(event.target.value)}
          placeholder={retry ? "原稿哪里有问题，或希望怎样调整？留空直接重试……" : "例如：放慢节奏，着重描写环境与人物反应……"}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); }
          }} />
        {retry && <p className="story-instruction-warning">{request.discardsFollowing
          ? "生成成功后将替换选中位置及后续剧情，请确认回退位置。已总结的长期记忆不会自动回滚。"
          : "生成成功后才替换原回复；失败或取消会保留原文。已总结的长期记忆不会自动回滚。"}</p>}
        <div className="story-instruction-footer"><button type="button" onClick={close}>取消</button>
          <button type="button" className="story-instruction-primary" disabled={busy || (!retry && !draft.trim())} onClick={submit}>
            {retry ? (draft.trim() ? "按要求重试" : "直接重试") : "发送导演指令"}
          </button></div>
      </dialog>, document.body)}
  </>;
}
