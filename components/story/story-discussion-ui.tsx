"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoryMessage } from "@/lib/story-storage";
import type { StoryDiscussion } from "@/lib/story-discussion";

export function StoryDiscussionBlock({ group, active, busy, readOnly, onPrepare, onEdit, onRetry }: {
  group: StoryDiscussion; active: boolean; busy: boolean; readOnly: boolean;
  onPrepare: () => void; onEdit: (message: StoryMessage, text: string) => void; onRetry: (id: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const rows = group.messages.filter(row => row.kind !== "discussion-end");
  const content = <>
    {rows.map(row => <div key={row.id} className="story-discussion-message" data-speaker={row.role}>
      <div className="story-discussion-message-heading"><span>{row.kind === "discussion-brief" ? "已确认的后续要求" : row.role === "user" ? "我 · 场外讨论" : "AI · 写作助手"}</span>
        {!readOnly && <button disabled={busy} onClick={() => { setEditing(row.id); setText(row.rawContent); }}>编辑</button>}
        {active && row.role === "assistant" && row.kind === "discussion" && row === rows.at(-1) && !readOnly && <button disabled={busy} onClick={() => onRetry(row.id)}>重试</button>}
      </div>
      {editing === row.id ? <div className="story-discussion-edit"><textarea value={text} onChange={e=>setText(e.target.value)} rows={5} />
        <button disabled={busy || !text.trim()} onClick={()=>{ onEdit(row, text.trim()); setEditing(undefined); }}>保存</button>
        <button onClick={()=>setEditing(undefined)}>取消</button></div> : <p>{row.rawContent}</p>}
    </div>)}
  </>;
  if (active) return <section className="story-discussion-block is-active" aria-label="正在进行的剧情讨论">{content}</section>;
  return <section className="story-discussion-block" onContextMenu={e=>{e.preventDefault();setMenu(true);}}
    onPointerDown={()=>{cancelHold();timer.current=setTimeout(()=>setMenu(true),550);}}
    onPointerMove={cancelHold} onPointerUp={cancelHold} onPointerCancel={cancelHold}>
    <details><summary>剧情讨论 · {rows.filter(row=>row.role === "user").length}轮{group.brief ? " · 已整理" : ""}<span>展开查看</span></summary>{content}</details>
    {!readOnly && <button className="story-discussion-more" aria-label="讨论记录操作" onClick={()=>setMenu(value=>!value)}>···</button>}
    {menu && !readOnly && <div className="story-discussion-menu"><button disabled={busy} onClick={()=>{setMenu(false);onPrepare();}}>{group.brief ? "重新整理后续要求" : "整理后续要求"}</button><button onClick={()=>setMenu(false)}>关闭</button></div>}
  </section>;
}

export function StoryDiscussionDialog({ mode, text, loading, error, onChange, onPrepare, onConfirm, onCancel, onExit }: {
  mode: "brief" | "overflow"; text: string; loading: boolean; error?: string;
  onChange: (text: string) => void; onPrepare: () => void; onConfirm: () => void; onCancel: () => void; onExit: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(()=>{ const node=dialog.current; node?.showModal(); return ()=>node?.close(); },[]);
  if (typeof document === "undefined") return null;
  return createPortal(<dialog ref={dialog} className="story-instruction-dialog story-discussion-dialog" onCancel={event=>{event.preventDefault();onCancel();}}>
    <div className="story-instruction-heading"><h2>{mode === "overflow" ? "部分讨论超出保留额度" : "整理后续要求"}</h2></div>
    <p>{mode === "overflow" ? "未整理讨论共享约 4k token 的原文额度，退出后较早的部分将不再随近期上下文发送。完整记录仍保存在这里。可以先整理明确的要求，也可以直接退出。" : "确认后作为近期创作要求参与后续剧情，随正文全文窗口退出；不会进入长期或向量记忆。"}</p>
    {mode === "brief" && <><textarea aria-label="后续创作要求" value={text} onChange={event=>onChange(event.target.value)} disabled={loading} rows={10} placeholder={loading ? "正在整理，请稍候……" : "可以直接修改这里的要求……"} /><p role="status">{error || (loading ? "正在生成整理稿，确认前不会生效。" : "请核对内容，尤其是已定方案与尚未决定的部分。")}</p></>}
    <div className="story-instruction-footer">
      <button onClick={onCancel}>{loading ? "停止并返回讨论" : "返回讨论"}</button>
      {mode === "overflow" ? <><button onClick={onExit}>直接退出</button><button className="story-instruction-primary" onClick={onPrepare}>整理后退出</button></>
        : <><button disabled={loading} onClick={onPrepare}>重新生成</button><button className="story-instruction-primary" disabled={loading || !text.trim()} onClick={onConfirm}>确认并结束讨论</button></>}
    </div>
  </dialog>,document.body);
}
