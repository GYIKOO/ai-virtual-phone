"use client";

import { useState } from "react";
import { StoryActions, StoryDirectorNote, type StoryActionRequest } from "./story-actions";

export default function StoryControlsPreview() {
  const [request, setRequest] = useState<StoryActionRequest | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [feedback, setFeedback] = useState("");
  const [round, setRound] = useState(1);
  return <main style={{ minHeight: "100dvh", background: "#eef1f5", padding: "24px 12px", color: "#334155" }}>
    <div style={{ maxWidth: 430, margin: "auto" }}>
      <p style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>本地 UI 预览 · 模拟回复 · 不调用 API、不写入存档</p>
      <section style={{ background: "#fff", borderRadius: 22, border: "1px solid #e2e8f0", overflow: "hidden" }}>
        <header style={{ padding: "22px 24px", borderBottom: "1px solid #e2e8f0" }}><h1 style={{ fontSize: 21 }}>剧情工具</h1><p style={{ fontSize: 12, color: "#64748b", marginTop: 6 }}>展开左下角菜单，试试导演指令和重试。</p></header>
        <div style={{ padding: 24, minHeight: 350 }}>
          <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>角色 · 模拟第 {round} 段</p>
          <p style={{ lineHeight: 2, fontSize: 15 }}>窗外的雨渐渐停了。他将书签放回书里，抬头看向门口，似乎还有一句话没有说完。</p>
          {notes.map((note, index) => <div key={index} style={{ marginTop: 22, padding: 14, background: "#f8fafc", borderRadius: 12 }}><StoryDirectorNote text={note} /></div>)}
          <p role="status" style={{ fontSize: 12, color: "#64748b", marginTop: 22 }}>{feedback}</p>
        </div>
        <footer style={{ display: "flex", alignItems: "center", gap: 10, padding: 14, background: "#fafbfc", borderTop: "1px solid #e2e8f0" }}>
          <StoryActions busy={false} retryTarget="preview" request={request} onRequest={setRequest} onSubmit={(action, text) => {
            setRequest(null);
            if (action.mode === "director") { setNotes(items => [...items, text]); setFeedback("模拟生成完成：导演指令已折叠。展开后可查看。"); }
            else { setRound(value => value + 1); setFeedback(text ? "模拟重试完成：使用了临时要求，要求未加入剧情记录。" : "模拟重试完成：没有附加要求。"); }
          }} />
          <textarea aria-label="剧情输入预览" placeholder="这是普通角色扮演输入……" rows={1} style={{ flex: 1, minWidth: 0, resize: "none", background: "#eef1f5", padding: 10, fontSize: 13, borderRadius: 10 }} />
        </footer>
      </section>
      <a href="/" style={{ display: "block", marginTop: 16, fontSize: 13 }}>进入本地 Float，配置测试角色后验证真实生成 →</a>
    </div>
  </main>;
}
