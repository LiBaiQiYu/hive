# HIVE · API 契约

> 基址：同域 `/api`。所有响应 `application/json`，时间字段为 **ISO 8601 字符串**（存储是毫秒整数，网关层转换）。

## 1. 通用约定

**成功**
```json
{ "data": {}, "meta": { "requestId": "0192...", "page": 1, "pageSize": 20, "total": 86 } }
```
**失败**
```json
{ "error": { "code": "RATING_ADJUSTMENT_OUT_OF_RANGE", "message": "修正值需在 -150 ~ 150 之间", "details": { "limit": 150 } },
  "requestId": "0192..." }
```

| code | HTTP | 场景 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 400 | Zod 校验失败，`details.fieldErrors` |
| `UNAUTHENTICATED` | 401 | 无 Cookie / 会话过期 |
| `FORBIDDEN` | 403 | 非管理员访问 `/api/admin/*` |
| `NOT_FOUND` | 404 | 资源不存在或无权可见（不区分，避免探测） |
| `CONFLICT` | 409 | 重复报名、Steam 已绑定、状态机不允许 |
| `VERSION_CONFLICT` | 409 | 分组编辑器乐观锁冲突 |
| `INVITE_INVALID` | 403 | 邀请码不存在 / 已撤销 / 已过期 / 已用尽（不区分，防枚举） |
| `RATE_LIMITED` | 429 | 登录失败次数超限 |
| `INTERNAL` | 500 | 未预期异常，仅返回 requestId |

写操作要求请求头 `X-HIVE-CSRF: 1`。分页参数 `page`（默认 1）、`pageSize`（默认 20，上限 100）。

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/register` | `{username, displayName, email, password, inviteCode}`。邀请制开启时 `inviteCode` 必填，校验失败返回 `INVITE_INVALID`；成功即登录 |
| POST | `/api/auth/login` | `{identifier, password}`，`identifier` 可为用户名或邮箱 |
| POST | `/api/auth/logout` | 撤销当前会话 |
| GET | `/api/auth/session` | 当前会话 + 用户 + 评分摘要 |
| POST | `/api/auth/password` | `{currentPassword, newPassword}`；新密码 ≥10 位、不得与旧密码相同；成功后**撤销其他所有会话**，当前设备保持登录 |
| GET | `/api/auth/reset-password/:token` | 校验邮件里的令牌：`{valid, expiresAt, username, displayName}`；无效或过期返回 `{valid:false}` |
| POST | `/api/auth/reset-password` | `{token, newPassword}`；令牌一次性（30 分钟），成功后作废令牌并撤销该账号**全部**会话，写审计 `user.password-reset-email` |
| GET | `/api/auth/steam/start` | 302 跳转 Steam；写 `hive_steam_state` Cookie。`openid.realm` / `return_to` 的 origin 取 `APP_ORIGIN`（见下方回调说明） |
| GET | `/api/auth/steam/callback` | Steam 回调，服务端反向校验后绑定，302 回 `/me?steam=linked`；失败一律 302 回 `/me?steam=error&reason=…` |
| DELETE | `/api/auth/steam/unlink` | 解绑（存在进行中赛事报名时返回 `CONFLICT`）；段位来源退回 `SELF_REPORTED` |

回调失败原因（`reason`）：`state`（Cookie 缺失/不匹配，或发起与回调不是同一个地址）、`return_to`（`openid.return_to` 与配置的 `APP_ORIGIN` 不一致）、`endpoint`、`claimed_id`、`post_failed`（服务器访问不到 `steamcommunity.com`）、`not_valid`（Steam 判定校验无效，通常已过期）、`taken`（该 Steam 已绑定别的账号）。前端必须把结果读出来提示用户，否则失败会表现为「点了没反应」。

登录失败统一返回 `UNAUTHENTICATED`，不区分"用户不存在"与"密码错误"。

## 3. 玩家

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me` | 档案 + 评分（`system` / `adjustment` / `effective` / `breakdown`）+ 位置偏好。`user.emailConfirmed` 表示本人有没有点过「我确认这个邮箱能收到信」。`gameAccount.avatarUrl` 是 Steam/STRATZ 抓来的公开头像（没抓到为 `null`，玩家卡据此决定是否渲染头像）。`breakdown` 来自 `player_ratings.breakdown_json`：`{components:[{key,weight,value,score,basis}], estimatedMmr, attendanceBp, attendancePlayed, attendanceRegistered}`，老数据为 `null` |
| PATCH | `/api/me` | `{displayName?, bio?, qqNumber?, email?, currentPassword?}`。改 `email` 时**必须**同时提供 `currentPassword`（密码错 → 401，邮箱被占用 → 409），并写审计 `user.email`——邮箱决定密码找回的信寄到哪。换邮箱会清空 `email_confirmed_at`，要求重新确认 |
| POST | `/api/me/email/confirm` | 记录"本人确认这个邮箱能收到信"（`email_confirmed_at = now`），写审计 `user.email-confirm`。它不验证任何东西，只是让顶部提醒消失；未确认时前端会一直提示 |
| PUT | `/api/me/positions` | `[{position, rank, proficiency}]`，5 条全量覆盖 |
| GET | `/api/me/rating-history` | 自己的评分调整记录（`rating_adjustments`，含原因与操作人，倒序最多 50 条） |
| GET | `/api/players` | 玩家列表，`?query=&position=&sort=rating|name&page=` |
| GET | `/api/players/:id` | 公开档案：段位、位置、英雄池 Top 10、近期战绩、评分构成；`summary.noShows` 是弃赛场次，`noShowMatches[]` 是明细（`{matchId, matchNo, eventId, eventTitle, at, position, side}`） |
| POST | `/api/me/steam/sync` | 投递同步任务，返回 `202 {queued: true}` |
| GET | `/api/leaderboard` | `?sort=rating\|wins&limit=`（默认 `rating`）；返回 `{rank, user, effective, wins, losses, played, winRateBp, noShows}`。`noShows` = 进了正选但没到场、被替补顶下来的场次（只展示，不参与排序）。`mvp` 排序暂不提供——`match_player_stats` 还没有数据 |
| POST | `/api/me/game-account/claim` | `{accountId: 109902856}` 声明式绑定：先查段位源（配了 `STRATZ_API_TOKEN` 走 STRATZ，否则退回 OpenDota）确认账号存在，写入 `provider=DOTA_ACCOUNT_ID`、`verification=CLAIMED`。抓到公开段位才覆盖 `player_stats` 并清掉手填 MMR；**抓不到时只更新场次，保留原有的自报段位**（旧绑定同步来的 `OPENDOTA` / `STRATZ` 段位会清掉），返回 `hiddenData: true` |
| DELETE | `/api/me/game-account` | 解绑；已有进行中报名时返回 `CONFLICT` |
| PUT | `/api/me/rank` | `{rankTier?, declaredMmr?}` 手动填写段位，写 `rank_source=SELF_REPORTED` |
| DELETE | `/api/me/rank` | 清空段位：`rank_tier` / `declared_mmr` / `rank_source` 一起置空并立即重算（回到 500 中性值）。只允许清自报数据，`OPENDOTA` / `STRATZ` / `ADMIN_SET` 返回 `CONFLICT`；本来就没数据时幂等返回 `{cleared: false}` |
| GET | `/api/me/verification` | 徽章状态：`{level, hasPublicData, rankSource, adminAdjustmentLimit}` |

`claim` 的语义要说死在契约里：**它验证的是"这个账号存在且有公开数据"，不验证"这是你的账号"**。所以响应必须原样返回 `verification: "CLAIMED"`，前端据此渲染黄色徽章，不允许把它显示成"已认证"。

玩家相关的响应对象统一增加 `verification` 字段（`VERIFIED` / `VERIFIED_NO_DATA` / `CLAIMED` / `SELF_REPORTED`）与 `ratingUncertainty`（整数，展示为 `±N`）。无段位数据的玩家 `rankTier` 为 `null`，前端显示"未公开"，**不要用 0 或默认段位冒充**。

`GET /api/players/:id` 与 `/api/me` 的 `rating` 对象必须完整返回，供 WARROOM Rating 浮窗直接渲染（详见 [UI.md §8](UI.md)）：

```json
{ "rating": {
    "system": 520, "adjustment": 50, "effective": 570,
    "confidenceBp": 10000, "uncertainty": 0,
    "algorithmVersion": "warroom-v3", "computedAt": 1761822000000,
    "breakdown": {
      "components": [
        { "key": "MMR", "weight": 1000, "value": 0.52, "score": 520, "basis": "SELF_MMR" }
      ],
      "estimatedMmr": 5200,
      "attendanceBp": 8000,
      "attendancePlayed": 8,
      "attendanceRegistered": 10
    } } }
```

`breakdown` 的 `components` 在 v3 只有 `MMR` 一项（权重 1000）；`attendanceBp` 是独立的出勤率（基点，NULL = 无记录），只用于候补排序。`system` 是实力分，不含出勤。

`adjustmentReason` 的可见性由角色决定：本人与管理员有值，其他玩家为 `null`（字段存在但为空，前端据此决定是否显示原因行，不要靠隐藏整块来"看起来没问题"）。**服务端过滤，不要交给前端判断**——前端过滤等于没有过滤。

## 4. 赛事与报名

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/events` | `?status=`，公开列表 |
| GET | `/api/events/:id` | 详情：容量、已报名数、候补数、场次列表 |
| POST | `/api/events/:id/registrations` | `{positionPreference, secondaryPosition?, note?}` |
| DELETE | `/api/events/:id/registrations` | 退赛；若已入正选阵容则拒绝（`CONFLICT`） |
| GET | `/api/events/:id/registrations` | 报名名单（玩家卡片数据源）：昵称、简介、位置、段位、MMR、评分、验证等级、`personaName`、`dotaAccountId`（只在玩家绑定/声明过时返回，公开给其他人去第三方核对） |

报名时机：`events.status = REGISTRATION_OPEN` 且当前时间在窗口内。写入时**必须**从 `player_ratings` 读取并写入三个快照字段 + `position_snapshot` + `snapshot_at`。

**到点自动结算**：`registration_closes_at` 不只是"拒绝新报名"。每分钟的 Cron 会扫一次到点的赛事，自动完成：关闭报名（`REGISTRATION_CLOSED`）→ 封盘（够 10 人就打，余数进候补）→ 生成阵容 → 发布（`PUBLISHED`），全部记 `SYSTEM` 审计（`event.auto-close` / `event.auto-finalize` / `match.publish`）。见 `services/event-auto.ts`。报名不足 10 人时只关闭报名、不猜"延期还是取消"，留给管理员。

名额规则（详见 [UI.md §5.1](UI.md)）：`capacity` 是**目标人数**（20 = 2 场 × 10），不是座位数。报名期一律 `CONFIRMED`，**不生成比赛**；封盘时按 `floor(confirmed / 10)` 切分场次，余数转 `WAITLIST` 并分配 `waitlist_position`。候补只在两种情况下出现：超出 `capacity`，或已经封盘。

赛事详情返回 `targetMatches`、`slotsToNextMatch`（还差几人凑满下一场）、`pendingBench[]`（封盘后的待定名单，封盘前为空）。

管理员也可以在截止前手动封盘（此时人数卡在两档之间必须显式选）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/events/:id/finalize` | `{policy?: "START_PARTIAL" \| "EXTEND" \| "CANCEL", extendHours?}`。人数卡在两档之间时（如 12 人 / 目标 2 场）必须显式选择，不允许服务端静默决定；Cron 自动结算那条路径视为已经选了 `START_PARTIAL` |

退赛或取消时：候补顺序自动前移；已 `PUBLISHED` 阵容中的玩家不允许退赛，需管理员先 `VOID` 该场次。

## 5. 智能分组（管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/matches/generate` | `{eventId, matchNo?, playerIds?, seed?}` → 创建 `DRAFT` 场次与两队 |
| GET | `/api/admin/matches/:id/lineup` | 编辑器数据：两队、每人评分/位置/契合度、总分差、位置覆盖、`version` |
| PATCH | `/api/admin/matches/:id/lineup` | `{version, moves: [{teamMemberId, toSide, toPosition}]}`；整份提交、`version` 不符返回 `CONFLICT`；只允许 `DRAFT`；服务端重算契合度与两队总分并 `version+1` |
| POST | `/api/admin/matches/:id/regenerate` | `{seed}`，仅 `DRAFT`；`version` 不变，`generation_seed` 更新 |
| POST | `/api/admin/matches/:id/publish` | 校验 10 人 / 位次唯一 / 两侧各 5 人 → 冻结快照 → `PUBLISHED` |
| GET | `/api/admin/matches/:id/substitutes` | 换人候选：本赛事已报名、还没进这场阵容的玩家（按出勤率 → 评分 → 报名时间排序，`busyInMatchNo` 标记已在其它场次）；同时返回本场换人流水 `history` |
| POST | `/api/admin/matches/:id/substitutions` | `{outMemberId, inUserId?, guest?: {name, mmr?}, reason?, note?}`；`inUserId` 与 `guest` 二选一。允许 `DRAFT` / `PUBLISHED` / `IN_PROGRESS`。换下原队员、按同一位置插入替补（临时参赛者 `user_id` 为空、只存名字），重算队伍总分/分差、`version+1`、写 `match_substitutions` 与审计 `match.substitute`。`reason` 默认 `ABSENT`（本人没来 → 记为**弃赛**，出勤率按未出场算），`MANUAL` 只是临场调整 |
| POST | `/api/admin/matches/:id/void` | 流局，`VOID` |
| GET | `/api/matches/:id` | 公开阵容：`PUBLISHED` / `IN_PROGRESS` / `COMPLETED` 可见，`DRAFT` 只有管理员能看（其他人 404）；返回与 lineup 同结构，含 `ratingGap` / `radiantWin` / 每人契合度；临时参赛者 `userId` 为 `null`、`isGuest=1` |

`PATCH lineup` 的响应必须带实时汇总，前端不用自己算：

```json
{ "data": {
    "version": 8,
    "teams": [
      { "side": "RADIANT", "totalRating": 3780, "averageRating": 756, "positionCoverage": "COMPLETE" },
      { "side": "DIRE",    "totalRating": 3760, "averageRating": 752, "positionCoverage": "COMPLETE" }
  ],
  "ratingGap": 20,
  "warnings": [{ "type": "POSITION_MISMATCH", "userId": "u_...", "position": 3, "fitScore": 40 }],
  "ratingDrift": [{ "userId": "u_...", "snapshot": 770, "current": 800 }] } }
```

- `warnings` 是提示不是阻断；`ratingDrift` 表示"发布快照后玩家评分被修正"，由管理员决定是否重新生成。
- 拖拽调整采用**整份提交**（而非逐次 PATCH 单个位置）：一次 batch 写入，避免中间态导致"两队各 4 人"的脏数据被读到。

## 6. 评分管理（管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/ratings/players` | 评分总表：段位、天梯分、系统分、修正、最终分、置信度、出勤与数据来源（`rankSource`） |
| PUT | `/api/admin/ratings/players/:id/declared-mmr` | `{mmr, reason}` 或 `{rankTier, reason}`：**设定目标天梯分或段位**（二选一），评分由系统重算 |
| PUT | `/api/admin/ratings/players/:id/rating-adjustment` | `{adjustment, reason, eventId?}`：直接调修正值（幂等，受 ±limit 限制） |
| GET | `/api/admin/ratings/players/:id/history` | 评分变更历史：修正变化、天梯分设定、段位设定合并为一条时间线（`kind` = `ADJUSTMENT` / `MMR` / `RANK`） |
| POST | `/api/admin/ratings/recompute` | 重算全部（或传 `{userId}` 单人）的系统分与出勤率，不动人工修正 |

`PUT declared-mmr` 纠正的是**输入数据**而不是结果，两种输入互斥（同时给或都不给 → `VALIDATION_FAILED`）：

- **天梯分模式** `{mmr}`：写入 `declared_mmr` 与对应段位（`rankTierFromMmr`），来源记为 `SELF_REPORTED`，最终分 = `round(mmr / 10)`。
- **段位模式** `{rankTier}`：勋章 × 10 + 星级（冠绝固定 `80`，0 星非法）。**不写** `declared_mmr`（写了会盖掉段位——`estimateMmr` 里 MMR 优先），评分按勋章区间估算 MMR 再 ÷ 10：统帅 5 星 = 2310 + 4 × 154 = 2926 → 293。来源记为 `ADMIN_SET`，玩家自己改不动。

两种模式都会把既有 `admin_adjustment` 清零，使最终分正好等于系统算出来的值。来源是 `STRATZ` / `OPENDOTA` 的玩家返回 `CONFLICT`（下次同步会覆盖，需先解绑）。`player_stats`、`player_ratings`、`audit_logs` 在同一个 batch 内写入（审计动作分别是 `rating.set-mmr` / `rating.set-rank`），随后调用统一重算补出置信度、出勤与 breakdown。

`PUT rating-adjustment` 是**幂等写**：`adjustment` 表示"新的修正值"而非增量，重复提交不会叠加。校验 ±limit 与原因长度后，更新 `player_ratings` 并插入 `rating_adjustments` + `audit_logs`，任何一步失败全部回滚。

## 7. 比赛结果与数据同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/matches/:id/result` | `{dotaMatchId}` 入队 `MATCH_IMPORT`；或 `{radiantWin, durationSeconds}` 手工录入。录入后**自动重算该赛事所有相关玩家的评分**（出勤口径变了） |
| GET | `/api/admin/jobs` | outbox 健康：`summary`（各状态计数）、`byKind`（类型×状态）、最近 50 条任务（含 `lastError`） |
| POST | `/api/admin/jobs/:id/retry` | 把 `DEAD` / `FAILED` 任务重置为 `PENDING`（`attempts` 归零、清空错误） |
| GET | `/api/admin/audit-logs` | `?actorId=&entityType=&action=&from=&to=&limit=`；返回 `entries` + 过滤候选 `actions` / `entityTypes` |

**邀请码（管理员）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/invite-codes` | 列表：码、标签、已用/上限、过期时间、状态 |
| POST | `/api/admin/invite-codes` | `{label, maxUses?, expiresAt?}`；`maxUses=0` 表示不限次 |
| POST | `/api/admin/invite-codes/:id/revoke` | 撤销；已注册用户不受影响，仅阻断后续使用 |

邀请码由服务端生成（8 位 Crockford Base32，避开易混字符 `0/O/1/I`），重复校验冲突即重试，最多 3 次。所有邀请码操作写 `audit_logs`。

## 8. 管理后台

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/dashboard` | `{members:{active,admins,newThisMonth}, events:{ongoing,total,openNow}, registrations:{thisMonth}, pendingPublish, jobs:{pending,running,dead,failed}, recentEvents}` |
| POST | `/api/admin/events` | 创建赛事（`title, capacity, registrationOpensAt, startsAt, serverRegion?`）；`serverRegion` 缺省为 `GLOBAL` |
| PATCH | `/api/admin/events/:id` | 编辑 `{title?, summary?, capacity?, registrationOpensAt?, registrationClosesAt?, startsAt?, serverRegion?}`，至少一个字段；时间字段传 `null` 表示清空。容量须为 10 的整数倍且不低于已确认人数；**报名关闭后容量与赛程不可改**（`CONFLICT`），标题/简介/服务器仍可改 |
| POST | `/api/admin/events/:id/transition` | `{to: "REGISTRATION_OPEN" \| "REGISTRATION_CLOSED" \| "COMPLETED" \| "ARCHIVED" \| "CANCELLED"}` |
| GET | `/api/admin/events/:id/registrations` | 含评分、位置分布统计、候补队列 |
| POST | `/api/admin/events/:id/registrations/:rid/promote` | 候补转正：置 `CONFIRMED` 并清空 `waitlist_position`，同一 batch 内把剩余候补重排为 1..n；正选已满、非候补、赛事已发布时返回 `CONFLICT` |
| PATCH | `/api/admin/users/:id/role` | `{role: "PLAYER" \| "ADMIN"}`；不能改自己的角色，也不能把最后一名管理员降级（`CONFLICT`），写审计 `user.role` |
| POST | `/api/admin/users/:id/reset-password` | 生成一次性临时密码（12 位、去掉易混字符），同时清空失败次数与锁定、**作废该用户全部会话**；响应里只出现一次，不写进审计（审计只记 `user.password-reset` 与会话数）。不能重置自己（`CONFLICT`），停用账号返回 `CONFLICT` |
| POST | `/api/admin/events/:id/notify-starting-soon` | `{mode: "TEST" \| "ALL"}`（默认 `TEST`）：发「赛前提醒」邮件。`TEST` 只发管理员自己一封（验通道），`ALL` 遍历确认名单里**可收信**的地址。返回 `{total, withEmail, sent, failed, error?}`；`error` 是 Cloudflare 原始错误码 + 一句中文处置建议。写审计 `event.notify`（`kind: "STARTING_SOON"`）。赛事没有 `startsAt` 时 `VALIDATION_FAILED` |

状态流转是白名单表，非法流转返回 `CONFLICT`，且每次流转写 `audit_logs`（`event.transition`，前后状态）。
转到 `COMPLETED` 时会自动重算该赛事所有报名者与上场者的评分（"报名且赛事已结束"才计入出勤）。
编辑赛事与候补转正同样落审计：`event.update`（改前/改后全字段）、`registration.promote`（候补位次 → 正选）。

## 9. 聚合与列表接口（首页 / 战绩 / 排行榜）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats/summary` | 首页四宫格：`{members, totalMatches, monthRegistrations, topPlayer}` |
| GET | `/api/matches` | `?eventId=&page=` 近期对局，按 `scheduled_at` 倒序；公开 |
| GET | `/api/me/matches` | 战绩页「我的对局」：`{summary:{played,wins,losses,winRateBp,noShows}, matches:[{matchId,eventTitle,side,won,durationSeconds,playedAt}], noShowMatches:[{matchId,matchNo,eventId,eventTitle,at,position,side}]}`。只算正选出场且比赛已结束有胜负的场次，**不含 KDA**（那要等对局导入）；`noShows` 是弃赛场次，单独列出、不计胜负 |
| GET | `/api/leaderboard` | `?sort=rating\|wins&limit=`，公开；胜场由 `team_members` + `matches.radiant_win` 现算，不依赖 `match_player_stats` |

```json
{ "data": [
    { "rank": 1, "user": { "id": "u_...", "displayName": "MoonLight", "avatarUrl": "..." },
      "effectiveRating": 927, "systemRating": 870, "adminAdjustment": 57,
      "matches": 23, "wins": 18, "winRateBp": 7826, "mvpCount": 8 } ],
  "meta": { "sort": "rating", "mvpSource": "DERIVED" } }
```

三条实现约束：

- `winRateBp` 用基点，前端 `/100` 显示；`matches = 0` 时返回 `null` 而不是 `0`，前端渲染 `—`。
- `mvpCount` 在没有导入赛后数据前为 `null`，`mvpSource` 标记 `DERIVED`（按 `performanceScore` 派生，见 [UI.md §5.2](UI.md)）。**不要用 0 冒充"没有数据"**。
- 排序必须稳定：同分按 `username` 升序做 tie-break，否则翻页会看到同一玩家出现两次。
