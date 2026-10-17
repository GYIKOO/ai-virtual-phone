import { CALENDAR_MANAGEMENT_CAPABILITY_ID, getInternalCapability } from "./internal-capability-storage";
import { loadCharacters } from "./character-storage";
import { resolveUserIdentity } from "./settings-storage";
import type { ContentAppId } from "./settings-types";
import { loadCalendarStore, loadCalendarWeekPlan, formatCalendarCommitments } from "./calendar-storage";
import { formatIsoDate, getWeekStartIso } from "./calendar-utils";
import { commitCalendarChanges, newCalendarChangeId, type CalendarChange, type PendingCalendarChanges } from "./calendar-changes";

export function createCalendarSync(characterIds: string[], app: ContentAppId, sessionId?: string, independent = false): PendingCalendarChanges | undefined {
  const permission=getInternalCapability(CALENDAR_MANAGEMENT_CAPABILITY_ID);
  if(independent || !permission?.enabled || permission.mode==="off") return;
  const identityId=resolveUserIdentity(app === "group_chat" ? undefined : characterIds[0],app)?.id || "";
  const existing=new Set(loadCharacters().map(row=>row.id));
  const allowed=[...new Set(characterIds)].filter(id=>existing.has(id) && (app === "group_chat" || (resolveUserIdentity(id,app)?.id || "")===identityId));
  if(!allowed.length) return;
  return {id:newCalendarChangeId(),revision:loadCalendarStore().revision,context:{characterIds:allowed,userIdentityId:identityId,app,sessionId,now:Date.now()},changes:[]};
}

/** Common operation contract, independently gated by the user's calendar capability. */
export function calendarSyncPrompt(batch: PendingCalendarChanges | undefined): string {
  if(!batch) return "";
  const now=new Date(batch.context.now), tomorrow=new Date(now); tomorrow.setDate(tomorrow.getDate()+1);
  const names=new Map(loadCharacters().map(row=>[row.id,row.name]));
  const ids=batch.context.characterIds;
  const plans=ids.map(id=>{
    const items=[...new Map([now,tomorrow].flatMap(day=>loadCalendarWeekPlan("character",id,getWeekStartIso(day),batch.context.userIdentityId)?.items||[]).map(item=>[item.id,item])).values()]
      .filter(item=>[formatIsoDate(now),formatIsoDate(tomorrow)].includes(item.date));
    return `${names.get(id)}（${id}）\n${items.map(item=>`${item.id} | ${item.date} ${item.startTime}-${item.endTime} | ${item.title}`).join("\n") || "暂无日程"}`;
  });
  const commitments=[...new Set(ids.flatMap(id=>formatCalendarCommitments(id,undefined,batch.context.userIdentityId).split("\n")).filter(Boolean))];
  return [
    "<calendar_management>",
    `日历使用系统本地时区 ${Intl.DateTimeFormat().resolvedOptions().timeZone}；现在 ${now.toLocaleString()}，今天 ${formatIsoDate(now)}，明天 ${formatIsoDate(tomorrow)}。`,
    "根据本轮已经确定的计划变化更新日历。普通日程可调整今天、明天尚未结束的安排；约定可保存更远的日期，时间待定时用 null。提议与已确认约定分别理解，仅保存已确认的约定。",
    "如需变更，在正文及摘要之后附加一个 <calendar_changes>JSON数组</calendar_changes>；没有变更时省略。每项用 op 指定操作。",
    'schedule.save：characterId、title、date（YYYY-MM-DD）、startTime/endTime（HH:MM）、location；修改已有项另带 id。schedule.cancel：characterId、id。',
    'commitment.save：title、participantIds（参与角色ID数组）、date、startTime、endTime、location；修改已有约定另带 id。commitment.cancel / commitment.complete：id。日期未定可为 null；时段未定时 startTime/endTime 均为 null。',
    "已确认约定独立保存，重生成日程会保留；变更约定使用其原ID。多人共同约定保存一次，并列出实际参与角色。",
    ...plans,
    `已有约定：\n${commitments.join("\n") || "无"}`,
    "</calendar_management>",
  ].join("\n");
}

export function extractCalendarChanges(raw: string, snapshot?: PendingCalendarChanges): { text: string; pendingCalendarChanges?: PendingCalendarChanges } {
  const match=raw.match(/<calendar_changes>\s*([\s\S]*?)\s*<\/calendar_changes>\s*$/i);
  if(!match) {
    const start=raw.toLowerCase().lastIndexOf("<calendar_changes>");
    if (start >= 0 && !raw.slice(start).toLowerCase().includes("</calendar_changes>"))
      return {text:raw.slice(0,start).trimEnd(),pendingCalendarChanges:snapshot ? {...snapshot,error:"正文已保留，日历变更不完整，未自动保存"} : undefined};
    return {text:raw};
  }
  const text=raw.slice(0,match.index).trimEnd();
  if(!snapshot) return {text};
  try {
    if (!text.trim()) throw new Error("缺少正文");
    if(match[1].length>32000) throw new Error("日历变更过长");
    const changes:unknown=JSON.parse(match[1]);
    if(!Array.isArray(changes) || changes.length>20) throw new Error("日历变更格式无效");
    return {text,pendingCalendarChanges:{...snapshot,changes:changes as CalendarChange[]}};
  } catch {
    return {text,pendingCalendarChanges:{...snapshot,error:"正文已保留，但日历变更格式无效，未自动修改日历"}};
  }
}

export function hideCalendarChangeStream(text: string): string {
  const cleaned = text.replace(/<calendar_changes>[\s\S]*$/i, "");
  const lastOpen = cleaned.lastIndexOf("<");
  return lastOpen >= 0 && "<calendar_changes>".startsWith(cleaned.slice(lastOpen).toLowerCase())
    ? cleaned.slice(0,lastOpen) : cleaned;
}

/** Called only after the host has accepted the generated message. Failure never invalidates prose. */
export async function applyAcceptedCalendarChanges(batch: PendingCalendarChanges | undefined, messageId: string): Promise<string | null> {
  if (!batch) return null;
  try {
    const permission = getInternalCapability(CALENDAR_MANAGEMENT_CAPABILITY_ID);
    if (!permission?.enabled || permission.mode === "off") return "日历管理已关闭，本次安排未自动保存";
    const existing = new Set(loadCharacters().map(row => row.id));
    if (batch.context.characterIds.some(id => !existing.has(id) || (resolveUserIdentity(batch.context.app === "group_chat" ? undefined : id,batch.context.app as ContentAppId)?.id || "") !== batch.context.userIdentityId))
      return "身份或角色配置已改变，本次安排未自动保存";
    return await commitCalendarChanges(batch,messageId);
  } catch {return "正文已保留，日历安排保存失败，请在日历中确认";}
}
