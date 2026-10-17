export type CalendarOwnerType = "user" | "character";

export type CalendarColorKey =
  | "blue"
  | "green"
  | "amber"
  | "rose"
  | "violet"
  | "teal"
  | "slate"
  | "lilac";

export type CalendarScheduleItem = {
  id: string;
  date: string;       // YYYY-MM-DD
  weekday: string;    // 周一 ~ 周日
  startTime: string;  // HH:MM
  endTime: string;    // HH:MM
  location: string;
  title: string;
  /** 事项 emoji 图标（可选，一个 emoji） */
  emoji?: string;
  colorKey: CalendarColorKey;
  source: "manual" | "generated";
  /** Read-only projection of a separately stored commitment. */
  commitmentId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CalendarWeekPlan = {
  id: string;
  ownerType: CalendarOwnerType;
  ownerId: string;
  weekStart: string; // YYYY-MM-DD, Monday
  items: CalendarScheduleItem[];
  updatedAt: string;
};

export type CalendarCommitment = {
  id: string;
  participantIds: string[];
  userIdentityId: string;
  title: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  location: string;
  status: "confirmed" | "completed" | "cancelled";
  source?: { app: string; sessionId?: string; messageId?: string };
  createdAt: string;
  updatedAt: string;
};
