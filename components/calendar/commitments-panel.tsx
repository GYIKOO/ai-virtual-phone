"use client";

import { useEffect, useState } from "react";
import { Check, ChevronLeft, Plus } from "lucide-react";
import { Input } from "../ui/form";
import { loadCharacters } from "@/lib/character-storage";
import { calendarIdentity, loadCalendarCommitments, loadCalendarStore } from "@/lib/calendar-storage";
import { commitCalendarChanges, newCalendarChangeId, type CalendarChange } from "@/lib/calendar-changes";
import type { CalendarCommitment } from "@/lib/calendar-types";

type Draft = {id?: string; title: string; date: string; startTime: string; endTime: string; location: string; participantIds: string[]; revision: number};

export function CalendarCommitmentsPanel({ownerId,initialId,onClose}: {ownerId?: string; initialId?: string; onClose: () => void}) {
  const identityId = calendarIdentity(ownerId);
  const characters = loadCharacters().filter(character => calendarIdentity(character.id) === identityId);
  const [rows,setRows] = useState(() => loadCalendarCommitments(ownerId,identityId));
  const [draft,setDraft] = useState<Draft | null>(null);
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const [showHistory,setShowHistory] = useState(false);
  const edit = (row?: CalendarCommitment) => {
    setNotice("");
    setDraft({id:row?.id,title:row?.title || "",date:row?.date || "",startTime:row?.startTime || "",endTime:row?.endTime || "",
      location:row?.location || "",participantIds:row?.participantIds || (ownerId ? [ownerId] : []),revision:loadCalendarStore().revision});
  };
  useEffect(() => {
    const update = () => setRows(loadCalendarCommitments(ownerId,identityId));
    window.addEventListener("calendar-updated",update);
    if (initialId) {
      const row = loadCalendarCommitments(ownerId,identityId).find(row => row.id === initialId);
      if (row) edit(row);
    }
    return () => window.removeEventListener("calendar-updated",update);
  },[ownerId,identityId,initialId]);

  const save = async (change: CalendarChange, revision: number) => {
    setBusy(true); setNotice("");
    const error = await commitCalendarChanges({
      id:newCalendarChangeId(),revision,context:{characterIds:characters.map(row => row.id),userIdentityId:identityId,app:"calendar",manual:true,now:Date.now()},
      changes:[change],
    });
    setBusy(false);
    if (error) {setNotice(error);return;}
    setDraft(null); setRows(loadCalendarCommitments(ownerId,identityId)); setNotice("已保存");
  };
  const stateChange = (row: CalendarCommitment,op: "commitment.cancel" | "commitment.complete") => {
    if (!window.confirm(op === "commitment.cancel" ? "取消这项约定？所有参与角色会同步更新。" : "将这项约定标记为完成？")) return;
    void save({op,id:row.id},loadCalendarStore().revision);
  };
  const visible = rows.filter(row => showHistory || row.status === "confirmed")
    .sort((a,b) => (a.date || "9999").localeCompare(b.date || "9999") || (a.startTime || "").localeCompare(b.startTime || ""));
  return (
    <div className="modal-overlay calendar-edit-modal-overlay" onClick={() => {if(!busy) onClose();}}>
      <div className="calendar-edit-modal" data-ui="calendar-commitments" onClick={event => event.stopPropagation()}>
        <div className="modal-header">
          <button className="modal-header-btn modal-header-btn-muted" aria-label="返回" disabled={busy} onClick={() => draft ? setDraft(null) : onClose()}><ChevronLeft size={18}/></button>
          <span className="modal-header-title">{draft ? draft.id ? "编辑约定" : "新增约定" : "约定"}</span>
          {draft ? <button aria-label="保存约定" className="modal-header-btn modal-header-btn-action" disabled={busy}
            onClick={() => void save({op:"commitment.save",id:draft.id,title:draft.title,date:draft.date || null,startTime:draft.startTime || null,
              endTime:draft.endTime || null,location:draft.location,participantIds:draft.participantIds},draft.revision)}><Check size={18}/></button>
            : <button aria-label="新增约定" className="modal-header-btn modal-header-btn-action" disabled={busy} onClick={() => edit()}><Plus size={18}/></button>}
        </div>
        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-10">
          <p className="menu-desc">约定独立保存，重新生成日程时会保留。日期和时间按设备本地时区填写，未定时可以留空。</p>
          {notice && <p role="status" className="menu-desc">{notice}</p>}
          {draft ? <fieldset disabled={busy} className="flex flex-col gap-3">
            <label className="menu-desc">事项<Input value={draft.title} maxLength={120} onChange={e => setDraft({...draft,title:e.target.value})}/></label>
            <label className="menu-desc">日期（可留空）<Input type="date" value={draft.date} onChange={e => setDraft({...draft,date:e.target.value})}/></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="menu-desc">开始时间<Input type="time" value={draft.startTime} onChange={e => setDraft({...draft,startTime:e.target.value})}/></label>
              <label className="menu-desc">结束时间<Input type="time" value={draft.endTime} onChange={e => setDraft({...draft,endTime:e.target.value})}/></label>
            </div>
            <button className="menu-desc text-left" type="button" onClick={() => setDraft({...draft,startTime:"",endTime:""})}>清空时段，稍后再定</button>
            <label className="menu-desc">地点<Input value={draft.location} maxLength={120} onChange={e => setDraft({...draft,location:e.target.value})}/></label>
            <span className="menu-desc">参与角色</span>
            {characters.map(character => <label key={character.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.participantIds.includes(character.id)} onChange={e => setDraft({...draft,
                participantIds:e.target.checked ? [...draft.participantIds,character.id] : draft.participantIds.filter(id => id !== character.id)})}/>{character.name}
            </label>)}
            {!characters.length && <p className="menu-desc">当前身份下暂无角色。</p>}
          </fieldset> : <>
            <label className="flex items-center gap-2 menu-desc"><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)}/>显示已完成／已取消</label>
            {!visible.length && <p className="menu-desc">暂无约定，点击右上角添加。</p>}
            {visible.map(row => <article key={row.id} className="rounded-xl border border-black/10 p-3 flex flex-col gap-2">
              <strong className="text-sm">{row.title}</strong>
              <p className="menu-desc">{row.date || "日期待定"} · {row.startTime ? row.startTime + "–" + row.endTime : "时间待定"}{row.location ? " · " + row.location : ""}</p>
              <p className="menu-desc">{row.participantIds.map(id => characters.find(character => character.id === id)?.name || "已移除角色").join("、")}
                {row.status === "completed" ? " · 已完成" : row.status === "cancelled" ? " · 已取消" : ""}</p>
              {row.status === "confirmed" && <div className="flex gap-4 text-sm">
                <button disabled={busy} onClick={() => edit(row)}>编辑</button>
                <button disabled={busy} onClick={() => stateChange(row,"commitment.complete")}>完成</button>
                <button disabled={busy} onClick={() => stateChange(row,"commitment.cancel")}>取消约定</button>
              </div>}
            </article>)}
          </>}
        </div>
      </div>
    </div>
  );
}
