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
| 2026-07-27 | `f86efc4` | 24 | 1 处（`chat-room.tsx`） | 聊天扩展插件系统（可执行 JS 沙箱）、Minimax 语音 language_boost、设置页账号管理、记忆库 iOS 内存防护等。无新依赖、无新 SQL、无新环境变量。冲突源于上游把 `chat-room.tsx` 从混合换行符统一为纯 LF，与我们插入的 2 行重叠；取我方内容并跟随上游归一化即可。 |
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

### 4. 群聊增加「删除群聊」入口
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

---

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
