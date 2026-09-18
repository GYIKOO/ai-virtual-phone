# 本地私有改动清单（LOCAL_CHANGES）

> 这个仓库是 `xiaolongbao0709/ai-virtual-phone` 的下游 fork，**单向同步上游、不回流贡献**。
> 本文件记录我们对「原作者已有文件」的所有改动，方便日后 `git merge upstream/main` 时快速分辨
> 「哪些是我们的私货 / 哪些是上游的新逻辑」，减少解冲突时的心智负担。
>
> 规则：
> - **新功能优先写成全新文件 / 新目录**（新 App 走 `lib/custom-app-*` SDK；新玩法复制
>   `lib/xxx-engine.ts + xxx-storage.ts + components/xxx/` 一套）。全新文件不会和上游冲突，**不必记在这里**。
> - **只有当你不得不改原作者的现有文件时**，才在下面登记一条。改动越小越集中越好。
> - **上游优先原则（2026-08-11 定）**：每次同步时对照下方「改动登记」检查上游提交——若作者
>   自己实现了与我们某条私货同类的功能或修复，**采用上游版本、删除我们的小修补**并划掉对应
>   登记条目。作者更新期内暂缓自研新功能，私货只保留「严重影响使用体验」级别的修复。

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

2026-09-17：同步 12 个上游提交至 `fc65539`，无冲突。新增通话悬浮窗/重回、小红书多图、照片墙取景、生图配置预设，并修复预设排序、参考图重试及收起键盘自动回复。收起键盘触发与线上/线下 Enter 拆分不是同一功能，四项本地优化继续保留；会话删除继续采用上游实现。无依赖、SQL 或环境变量变更。

2026-09-10：同步 9 个上游提交至 `9e7feb8`。仅 `lib/chat-storage.ts` 默认设置发生相邻新增冲突，保留线下回车开关与上游悬浮球停靠开关两个字段。上游删除会话实现继续沿用；空会话可见、便签墙入口、线上/线下回车拆分、会话级主动消息控制仍无上游等效实现，保留现有补丁。此次未修改主动消息触发路径。无依赖变更；一体 SQL 补齐可选模块，egress 预防脚本统一格式，仍需事先建好相关表。

| 日期 | 同步到上游提交 | 上游提交数 | 冲突 | 备注 |
|---|---|---|---|---|
| 2026-07-12 | `e136608` | 121 | 无 | 首次同步。新增联机玩法、全屏特效、思维链展示/翻译、栖所 2.0、dock 拖拽等。新依赖 `@supabase/realtime-js`；新增 `docs/online-play-supabase.sql`、`docs/moderation-supabase.sql` 需按需执行。 |
| 2026-07-27 | `f86efc4` | 24 | 1 处（`chat-room.tsx`） | 聊天扩展插件系统（可执行 JS 沙箱）、Minimax 语音 language_boost、设置页账号管理、记忆库 iOS 内存防护等。无新依赖、无新 SQL、无新环境变量。冲突源于上游把 `chat-room.tsx` 从混合换行符统一为纯 LF，与我们插入的 2 行重叠；取我方内容并跟随上游归一化即可。 |
| 2026-09-xx (二) | `234b200` | 148 | 2 处（`chat-message-list.tsx` 过滤行、`chat-settings-panel.tsx` import 行） | **上游优先原则首次实际触发**：上游 `92b1307` 与 `504ed77` 分别实现了我们的 #2（列表不隐藏线下会话）与 #4（会话删除，且清理范围更全）。#4 按规矩整体回退采用上游版；#2 采用上游的线下修复与预览/排序改进，但用户要求保留「一条消息都没有的会话也不隐藏」，故改为叠在上游版之上的薄私货（删过滤行 + 其唯一用途的 helper）；另获「重复会话合并」弹窗（`9ca5efc`）。#5 主动消息开关随上游新落地的「冷场重连」与**服务端兜底预约**扩展：新增 `cancelProactiveForSession`（撤本地排队 + 撤云端预约），并 gate 冷场重连开火/重挂、兜底刷新器、定时唤醒工具排定；另一会话已于 `7eb6952` 把 #5 扩到经期关怀。其余：MCP 直连、NovelAI 原生生图、流式生成 UI（社区 #155-157）、预设多选、微信运行包同步提速、KV 数据丢失风险修复、`remark-cjk-friendly` 修中文加粗。新依赖 `remark-cjk-friendly`。新 SQL：`push-supabase.sql`（+82，仅用个人云推送/现实桥者需重跑）；特调 SQL 补 `preface` 约束。 |
| 2026-09-xx | `de1a5c7` | 197 | 1 处（`chat-settings-panel.tsx` 的 import 行，两侧全保留） | **上游优先核查：5 条私货上游均未实现，全部保留。** 新内置大件「独家特调」（材料/配方/对局的完整创作玩法，需独立 Supabase 项目 `MIXOLOGY_SUPABASE_*`）、**Supabase 出站流量治理**（公共列表进 CDN 缓存、轻量列表端点、账号鉴权合并为单 RPC、便签墙轮询降频）、社区 PR 潮（阅读器四连、短期记忆来源勾选、正则 historyOnly、会话虚拟时钟、收起键盘自动回复）、备份可靠性修复（导出静默失败告警、逐模块流式降内存）。无新依赖。**新增 4 个 SQL**：`supabase-egress-optimization.sql`、`supabase-egress-preventive.sql`（建议跑，降 egress）、`supabase-cleanup.sql`（空间清理，含 pg_cron 日志 truncate）、`mixology-supabase.sql`（仅玩特调才需要，且要独立项目）。 |
| 2026-08-15 | `996e214` | 135 | 2 处（`chat-storage.ts`、`user-profile-panel.tsx`，均为相邻添加，两侧全保留） | 最大一波：**角色电脑**（角色/小坊可读写自己的"硬盘"、执行 shell、发文件进聊天，一键部署容器版）、**自定义状态栏**（契约+渲染+方案库）、**共同建设**（资源集市社区贡献分区，无 Git 门槛）、音乐"我的"页重构、桌面图标拖拽合并成组（iOS 式文件夹）、社区 PR 潮（#98-#110：角色卡版本历史、小卷多会话、表情包搜索联想、Minimax 语速、沉浸显示模式+安卓回车修复等）。**按上游优先原则核查：社区 #105 的 Enter 修复在 `shouldSendChatInputOnEnter` 内部，与我们的线上/线下拆分（调用处传参）互补而非重叠，四条私货全部保留。** 内置预设 258→260。无新依赖、无新 SQL。 |
| 2026-08-11 | `52d5b95` | 48 | 无（上游未碰我们的 6 个文件） | 资源集市正式开张打磨：主题包/单条预设条目导入、上传前公开性确认、集市导入作品禁止再发布（权益保护）、摊主钥匙跨设备+纳入备份、作者资料卡、自动审核开关、导入链路修 6 问题；另有工坊渐进模糊、动态卡片编辑/删除点击无响应修复。无新依赖、无新 SQL。 |
| 2026-08-10 | `c8dcfc7` | 50 | 无（上游未碰我们的 6 个文件） | 全新「资源集市」App：后端为作者公开仓库 `xiaolongbao0709/ai-virtual-phone-share` + jsDelivr CDN（不经过我们的 Supabase，零流量负担），社区共享预设/角色卡/CSS，可应用内上传（Token 直传或经 floatshare.netlify.app 代传）、送花、管理审核；仓库地址可在 App ⚙ 更换。另有 MCP 401 分流修复、图片预览按钮收进全屏层。无新依赖、无新 SQL。 |
| 2026-08-09 | `74f0233` | 45 | 无（上游未碰我们的 6 个文件） | 日历 App 大改版（仿苹果双页结构：整页月历+时间轴详情、多天日程、1/2/3/5/7 每页天数、农历 lib）、黑市滚动跳顶系列修复、GIF 表情上传不再拍平、应用市场按 APP 编辑桌面图标+已发布直接导出、工坊低端机 OOM 修复+版权护栏、剧情绑定失效白屏修复。无新依赖、无新 SQL。 |
| 2026-08-08 | `12b3047` | 70 | 无 | **含微信云端助手 egress 修复 `b0335eb`**（待回复标志短路空闲轮询 + 运行包缓存 + 修 list 截断 bug）——重开云端轮询前需重新部署站点并让小手机同步新运行包。其余：工坊(小坊)大规模开发(答疑/环境体检/GitHub 分段写入/发布体检)、应用市场发布模型改版、SSE 容错解析。无新依赖、无新 SQL。 |
| 2026-08-05 | `9b9d7ae` | 39 | 无 | 音乐 App「夜光Lumen」视觉升级（沉浸播放页/发光歌词/评论区/歌手主页/听歌周报/自定义全局背景）、新内置「工坊」App（文档答疑+诊断+GitHub 查改代码，开发中）、游戏大厅/黑市剧场本机测试。无新依赖、无新 SQL、无新环境变量。 |
| 2026-08-03 | `178dbf9` | 55 | 无 | 剧情模式 UI 大改版（宋体纸张风、长卡片、脚注式折叠块、实心图标）、自定义 CSS iOS 修复、3x3 DIY 组件修复、朋友圈用户事实纪律。新依赖 `@heroicons/react`。**内置预设 257→258**：直接改过内置预设的用户会被出厂内容覆盖（自建预设不受影响）。 |
| 2026-08-01 | `a3f1419` | 51 | 无（上游未碰我们的 6 个文件） | 微信云端助手（Supabase Edge Function 一键部署）、桌面 DIY 组件套件、预设/世界书/正则条目左滑操作、主页名片组件、应用市场防套取（私有桶签名下载）。无新依赖；build 脚本前置了 `build-weixin-assistant-dist.mjs`。**需重跑 SQL**：`game-hall`、`black-market`、`custom-app-market` 三个脚本有安全加固（收回 anon 直读等），已部署这些功能的站点应在 Supabase 重跑对应脚本（或直接跑 `supabase-all-in-one.sql`）。 |

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

### 2. 聊天列表不隐藏「无内容」的会话（2026-09 改为叠在上游版之上的薄私货）
- **现状**：上游 `92b1307` 已自行修复线下根因（`hasSessionListContent`：线上可见消息**或**线下记录任一
  存在即保留，并补了线下摘要预览、按线上/线下更晚者排序）——这些改进全部采用。但上游版仍会隐藏
  「一条消息都没有」的全新会话（建群后删掉系统消息就退出那种），用户实际使用影响较大，故保留
  一条更薄的私货：**删掉 `if (!hasSessionListContent(s.id)) return false;` 及其唯一用途的 helper**
  （helper 不删会触发未使用 lint），加注释说明。与上游差异 3+/9-。
- **合并提示**：若上游把过滤放宽到空会话也保留，删掉本条即可；若上游给 helper 加了新用途，
  只删过滤行、保留 helper。以下为 2026-07 首版的历史记录：
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

### 3. 回车发送拆分为线上 / 线下两个开关
- **文件**：
  - `lib/chat-storage.ts`：`ChatAppSettings` 新增 `offlineEnterToSendEnabled`（默认 `false`）
  - `components/chat/chat-room.tsx`：新增 `offlineEnterToSendEnabled` 状态并同步，
    `OfflineTextInputBar` 改用它（`ChatTextInputBar` 仍用原来的 `enterToSendEnabled`）
  - `components/chat/user-profile-panel.tsx`：设置项拆成「回车发送 · 线上」「回车发送 · 线下」两行
- **原因**：原本一个开关同时管线上线下。线上是短消息、习惯回车即发；线下是小说体、
  常需多段换行。绑在一起必然有一边别扭。
- **实现要点**：`chat-room.tsx` 里本来就有 `ChatTextInputBar`（线上）和 `OfflineTextInputBar`
  （线下）两个独立输入组件，此前被喂了同一个值，因此拆分只需分别传值。
  小卷助手（`mascot-chat-room.tsx`）属线上形态，仍沿用 `enterToSendEnabled`，未改。
- **默认值**：线下独立默认 `false`（不回车发送）。老用户若原先开了回车发送，
  升级后线上保持开启、线下变为关闭——正是本次想要的手感。
- **合并提示**：若上游自己也做了同样拆分，优先采用上游字段名并删掉本条。

### 4. ~~群聊增加「删除群聊」入口~~ —— 已于 2026-09 被上游取代，改动已回退
- **结局**：上游 `504ed77` 新增「删除会话」（私聊/群聊通用）+ `lib/chat-session-remove.ts`
  `removeChatSessionCompletely`，清理范围是我们版本的**严格超集**（额外掐掉后台生成、剧场模式、
  待回复标记、自定义状态栏、键盘自动发送等散落开关）。按上游优先原则整体采用，我们的按钮/弹窗/
  handler 已全部移除。以下为历史记录：
- **文件**：`components/chat/chat-settings-panel.tsx`
- **改动**：在「危险操作」分组内为群聊新增「删除群聊」按钮 + 二次确认弹窗，
  调用 `deleteChatSession(session.id)`，并先调 `clearChatOfflineTurns(session.id)`。
- **原因**：私聊有「删除好友」，群聊却**没有任何删除入口**——`deleteChatSession` 在
  `lib/chat-storage.ts:871` 早已实现且逻辑完整，但全项目**没有一处调用**（孤儿函数）。
  配合原本的「无可见消息即隐藏」判定（见第 2 条），重复建出来的群既看不见也删不掉。
- **实现要点**：
  - `deleteChatSession` 只清主消息表，会话级的其余数据需自己补，否则留下孤儿：
    `clearChatOfflineTurns`（线下轮次，独立 KV）、`clearFollowUpSchedule`（后续跟进）、
    `clearTimedWakeSchedule`（定时唤醒）。
  - **删除范围经过核对**：这三个清理函数都按 `sessionId` **字段精确相等**过滤
    （非 ID 前缀匹配），只影响本会话；长期记忆按 `characterId` 索引、不挂 sessionId，
    因此删群**不会**牵连角色记忆。
  - **不触发角色感知**：`triggerDeleteFriendReaction` 只在「删除好友」处调用，删群不调。
    删除路径唯一派发的 `CHAT_MESSAGES_DELETED_EVENT` 全项目仅 `weixin-cloud-sync.ts` 监听
    （同步删除到微信助手上传队列），不产生消息、不喂给模型——纯数据清理，
    没有「解散群聊、成员收到通知」的剧情语义。
  - 删除后复用 `onDeleteFriend` 回调返回列表——父组件（`chat-room.tsx:5734`）把它接的就是
    `() => onBack()`。这样**不必改动 `chat-room.tsx`**（那个文件有换行符陷阱，见下）。
  - 列表会自动刷新：`onBack()` 让 `activeSession` 变 null，
    `chat-message-list.tsx` 的 effect 随即重新 `loadChatSessions()`。
- **合并提示**：若上游自己补了群聊删除，优先采用上游实现并删掉本条；
  但请确认上游是否也清理了线下 KV，没清的话保留我们这半句。

### 5. 会话级「允许主动消息」开关
- **文件**：
  - `lib/chat-storage.ts`：`ChatSession` 新增 `proactiveDisabled?: boolean`（默认 undefined=允许，老会话行为不变）
  - `lib/follow-up-service.ts`：本地触发源全部 gate——`scheduleFollowUp` 创建侧（追发唯一入口，
    同时 `cancelFollowUpBailout` 撤云端预约）、`fireTimedWake`（定时唤醒）、`fireIdleReconnect`（冷场重连，
    2026-09 上游新落地）、`fireMenstrualPeriodCare`（经期关怀，另一会话 `7eb6952` 补入）；`cancelFollowUp`
    里用户发消息后重挂冷场兜底的分支也按开关跳过；新增导出 `cancelProactiveForSession(sessionId)`：
    清本地排队（追发/定时唤醒）+ 撤服务端预约（追发键、每条定时唤醒键、冷场规则前缀）
  - `lib/push-bailout-client.ts`：**服务端兜底预约的三个入口** `armFollowUpBailout` / `armIdleReconnectBailout` /
    `armTimedWakeBailout` 在会话查找后统一 gate（一处罩住工具排定、后台刷新器 `refreshScheduledBailouts`、
    设置页手动测试三条调用路径）；`armPeriodCareBailouts` 的会话筛选同样排除已关闭会话
  - `components/chat/chat-settings-panel.tsx`：聊天信息页「置顶聊天」下方「允许主动消息」开关；
    关闭时调 `cancelProactiveForSession` 立即生效
- **原因**：float 的主动消息没有任何按角色的控制。用户玩同人卡，大量非重要 NPC 好友频繁主动
  要求做事/见面造成压力；但主要角色仍希望保留主动消息，不能全局一刀切（追发的触发器是焦虑值
  状态数字，与预设条目解耦，关提示词条目无法阻止 API 调用——见调查结论）。
- **实现要点**：gate 设在**创建侧 / 开火前 / 服务端预约入口**三层，本地与云端兜底一致，不留幽灵
  调用：上游的个人云推送会把追发/冷场重连/定时唤醒预约到 Edge Function，手机休眠时由云端代发——
  只 gate 本地会让 NPC 绕道云端发消息，故预约入口必须一并掐断。群聊会话同样可用。
- **合并提示**：若上游自己实现了按角色/会话的主动消息控制，按上游优先原则采用上游版并删除本条
  （核对上游是否覆盖：焦虑值追发路径、冷场重连、服务端兜底预约——FAQ 目前教的关条目方案
  并不能真正阻止追发调用）。若上游新增了别的主动消息源，需在其本地开火处与服务端预约处补同款 gate。

---

## 合并期间还原 package-lock 噪音的正确姿势（2026-09 踩坑）

本地 `npm install` 会给 lock 加 `"peer": true` / `"license"` 元数据噪音，惯例是不提交、还原。
**但在合并进行中（有 MERGE_HEAD 时）绝不能用 `git restore --staged` + `git restore`**：
它会把锁退回**合并前的旧 HEAD**，丢掉上游新增依赖的锁条目（2026-09 实测丢了 101 行，
含 `remark-cjk-friendly`），部署端 `npm ci` 会因 lock 与 package.json 不一致而失败。
正确做法：`git checkout upstream/main -- package-lock.json`（直接取上游版），或干脆不在
合并提交里碰锁文件、合并后再单独处理。

## 本地构建已知怪癖：OneDrive 竞态偶发吞掉 backdrop-filter 后处理

仓库在 OneDrive 目录下。`next build` 刚写完 `.next/static/css` 时 OneDrive 会抢着上传，
那几秒内目录项可能不被识别为普通文件，`scripts/restore-backdrop-filter.mjs` 会打出
`scanned 0 css files` 并静默跳过（2026-08-10 实测复现，几分钟后自愈）。

- 2026-08-11 补充：OneDrive 还会把**上次构建遗留的未改动 CSS 脱水**成云占位文件，让 scanned
  数字长期偏小（如 4→1）。**判断标准别看 scanned 数，看主样式文件是否被处理**：正常构建
  应有 `updated 1 files, inserted +140 左右`；若 `inserted 0` 且主样式很大，才是真中招。
- **修复**：稍等片刻后手动补跑一次 `node scripts/restore-backdrop-filter.mjs`（幂等）。
- **影响范围**：仅本地构建产物；Netlify/Vercel 在云端构建，不受影响。

## 换行符陷阱（已于 2026-07-27 同步后解除，保留备查）

本仓库 `core.autocrlf=true` 且没有 `.gitattributes`。**`chat-room.tsx` 曾经**在 blob 里存着
混合换行符（约 4829 行 CRLF、其余 LF），`autocrlf` 无法对这种文件无损往返，任何「整体重写」
的编辑都会把它归一化，**凭空产生约 1311 行假改动**（实测 8 行真改动被放大成 2622 行 diff）。

**上游已在 2026-07-27 那批提交里把该文件统一成纯 LF，陷阱就此解除**，现在可正常编辑。
（也正因两边换行符形态不同，那次同步在本文件产生了唯一一处冲突——内容其实无实质分歧。）

仍值得保留的通用习惯：

- 改完大文件后扫一眼 `git diff --stat`；行数远超预期就是踩了换行符坑。
- 对照命令：`git --no-pager diff --stat --ignore-all-space` 显示真实改动量。
- 真踩到了：`git checkout -- <file>` 还原，改用**按字节定点替换**的脚本重新应用
  （读写用 latin1，插入的中文先转 UTF-8 字节；替换时沿用锚点行自身的换行符）。
- 别为了「根治」而加 `.gitattributes` 强制统一换行符——那会一次性改写整个文件，
  和上游产生永久冲突面。
