# 本地私有改动清单（LOCAL_CHANGES）

> 这个仓库是 `xiaolongbao0709/ai-virtual-phone` 的下游 fork，**单向同步上游、不回流贡献**。
> 本文件记录我们对「原作者已有文件」的所有改动，方便日后 `git merge upstream/main` 时快速分辨
> 「哪些是我们的私货 / 哪些是上游的新逻辑」，减少解冲突时的心智负担。
>
> 规则：
> - **新功能优先写成全新文件 / 新目录**（新 App 走 `lib/custom-app-*` SDK；新玩法复制
>   `lib/xxx-engine.ts + xxx-storage.ts + components/xxx/` 一套）。全新文件不会和上游冲突，**不必记在这里**。
> - **只有当你不得不改原作者的现有文件时**，才在下面登记一条。改动越小越集中越好。

## 同步上游的操作

```bash
git fetch upstream
git checkout main
git merge upstream/main      # 冲突时对照本文件判断
npm install && npm run build # 验证能构建
git push origin main         # 推到我们自己的仓库（触发部署重建）
```

- `git push upstream` 已被禁用（push 地址设为无效值），不会误把私货推回原作者。
- 上游有 `main`（正常设备版）和 `test`（兼容设备版）两个分支，我们跟 `upstream/main`。

---

## 上游同步记录

| 日期 | 同步到上游提交 | 上游提交数 | 冲突 | 备注 |
|---|---|---|---|---|
| 2026-07-12 | `e136608` | 121 | 无 | 首次同步。新增联机玩法、全屏特效、思维链展示/翻译、栖所 2.0、dock 拖拽等。新依赖 `@supabase/realtime-js`；新增 `docs/online-play-supabase.sql`、`docs/moderation-supabase.sql` 需按需执行。 |

> 回滚点：同步前会打 tag（如 `pre-upstream-sync-2026-07`），出问题可 `git reset --hard <tag>`。

---

## 改动登记

### 1. 打开便签墙入口
- **文件**：`components/diary/diary-app.tsx`
- **改动**：`const NOTE_WALL_UI_ENABLED = false;` → `true`
- **原因**：原作者在公开版里默认关掉了便签墙 UI 入口。我们自建了 Supabase 便签墙表
  （`docs/notewall-supabase.sql`）并配好了 `NEXT_PUBLIC_SUPABASE_URL/ANON`，需要把入口露出来。
- **提交**：`a98fe2d feat: enable note wall entry in diary app`
- **合并提示**：若上游改动了这一行（例如自己也把它设为 `true`，或重构了这段开关逻辑），
  以「便签墙入口保持开启」为准即可。

### 2. 聊天列表不再隐藏「无可见消息」的会话
- **文件**：`components/chat/chat-message-list.tsx`（会话列表的 `.filter()` 内）
- **改动**：删掉 `if (!getLastVisibleSessionMessage(s.id)) return false;`，改为注释说明。
- **原因**：原逻辑会把「没有可见消息」的会话整条从列表里剔除，导致两个实际问题：
  1. 新建群后还没发言（或习惯性删掉「邀请角色加入群聊」的系统消息）就返回列表，群直接消失；
  2. 只走过**线下**剧情的群同样不算数（线下轮次存在 `chat-offline-storage` 的独立 KV 里，
     不进主消息表，因此永远不构成「可见消息」）。
  而角色侧该群依然存活、还会主动发消息进来，用户却找不到入口，只能重复建同名群。
- **安全性**：空会话的渲染与排序原本就有兜底——`SessionItem` 的 `displayTime` 用
  `session.updatedAt`、`preview` 有 `getLastNonEmptyPreview` 兜底，排序同样 `|| a.updatedAt`。
  所以删掉过滤不会产生崩溃或错位，只是空会话预览行留白。
- **合并提示**：若上游重构了这段 `.filter()`，保留「不按有无可见消息过滤」这一诉求即可；
  若上游自己也修了同一问题（例如改成只对私聊生效），优先采用上游实现并删掉本条。
