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
| POST | `/api/auth/password` | `{currentPassword, newPassword}`，撤销其他所有会话 |
| GET | `/api/auth/steam/start` | 302 跳转 Steam；写 `hive_steam_state` Cookie |
| GET | `/api/auth/steam/callback` | Steam 回调，服务端反向校验后绑定，302 回 `/me` |
| DELETE | `/api/auth/steam` | 解绑（存在进行中赛事报名时返回 `CONFLICT`） |

登录失败统一返回 `UNAUTHENTICATED`，不区分"用户不存在"与"密码错误"。

## 3. 玩家

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/me` | 档案 + 评分（`system` / `adjustment` / `effective` / `breakdown`）+ 位置偏好 |
| PATCH | `/api/me` | `{displayName?, bio?, qqNumber?}` |
| PUT | `/api/me/positions` | `[{position, rank, proficiency}]`，5 条全量覆盖 |
| GET | `/api/players` | 玩家列表，`?query=&position=&sort=rating|name&page=` |
| GET | `/api/players/:id` | 公开档案：段位、位置、英雄池 Top 10、近期战绩、评分构成 |
| POST | `/api/me/steam/sync` | 投递同步任务，返回 `202 {queued: true}` |
| GET | `/api/leaderboard` | `?sort=rating\|wins\|mvp`，默认 `rating`；含 `winRateBp`、`mvpCount`，详见 §9 |
| POST | `/api/me/game-account/claim` | `{accountId: 109902856}` 声明式绑定：先查 OpenDota 确认账号存在，写入 `provider=DOTA_ACCOUNT_ID`、`verification=CLAIMED` |
| DELETE | `/api/me/game-account` | 解绑；已有进行中报名时返回 `CONFLICT` |
| PUT | `/api/me/rank` | `{rankTier?, declaredMmr?}` 手动填写段位，写 `rank_source=SELF_REPORTED` |
| GET | `/api/me/verification` | 徽章状态：`{level, hasPublicData, rankSource, adminAdjustmentLimit}` |

`claim` 的语义要说死在契约里：**它验证的是"这个账号存在且有公开数据"，不验证"这是你的账号"**。所以响应必须原样返回 `verification: "CLAIMED"`，前端据此渲染黄色徽章，不允许把它显示成"已认证"。

玩家相关的响应对象统一增加 `verification` 字段（`VERIFIED` / `VERIFIED_NO_DATA` / `CLAIMED` / `SELF_REPORTED`）与 `ratingUncertainty`（整数，展示为 `±N`）。无段位数据的玩家 `rankTier` 为 `null`，前端显示"未公开"，**不要用 0 或默认段位冒充**。

`GET /api/players/:id` 与 `/api/me` 的 `rating` 对象必须完整返回，供 WARROOM Rating 浮窗直接渲染（详见 [UI.md §8](UI.md)）：

```json
{ "rating": {
    "system": 720, "adjustment": 50, "effective": 770,
    "confidence": 0.62, "uncertainty": 114,
    "algorithmVersion": "warroom-v1", "computedAt": "2026-10-30T08:00:00Z",
    "breakdown": [
      { "key": "RANK", "weight": 350, "score": 262, "basis": "MMR" },
      { "key": "FORM", "weight": 250, "score": 171, "basis": "OPENDOTA_RECENT" },
      { "key": "POSITION", "weight": 200, "score": 150, "basis": "PROFICIENCY" },
      { "key": "HERO_POOL", "weight": 120, "score": 74, "basis": "OPENDOTA" },
      { "key": "COMMUNITY", "weight": 80, "score": 63, "basis": "ATTENDANCE" } ],
    "adjustmentReason": "社区内战实际表现较强",
    "referencedMmr": 4300 } }
```

`adjustmentReason` 的可见性由角色决定：本人与管理员有值，其他玩家为 `null`（字段存在但为空，前端据此决定是否显示原因行，不要靠隐藏整块来"看起来没问题"）。**服务端过滤，不要交给前端判断**——前端过滤等于没有过滤。

## 4. 赛事与报名

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/events` | `?status=`，公开列表 |
| GET | `/api/events/:id` | 详情：容量、已报名数、候补数、场次列表 |
| POST | `/api/events/:id/registrations` | `{positionPreference, secondaryPosition?, note?}` |
| DELETE | `/api/events/:id/registrations` | 退赛；若已入正选阵容则拒绝（`CONFLICT`） |
| GET | `/api/events/:id/registrations` | 报名名单（公开：昵称 + 位置；评分仅管理员可见） |

报名时机：`events.status = REGISTRATION_OPEN` 且当前时间在窗口内。写入时**必须**从 `player_ratings` 读取并写入三个快照字段 + `position_snapshot` + `snapshot_at`。

名额规则（详见 [UI.md §5.1](UI.md)）：`capacity` 是**目标人数**（20 = 2 场 × 10），不是座位数。报名期一律 `CONFIRMED`，**不生成比赛**；封盘时 `finalizeRoster()` 按 `floor(confirmed / 10)` 切分场次，余数转 `WAITLIST` 并分配 `waitlist_position`。候补只在两种情况下出现：超出 `capacity`，或已经封盘。

赛事详情返回 `targetMatches`、`slotsToNextMatch`（还差几人凑满下一场）、`pendingBench[]`（封盘后的待定名单，封盘前为空）。

**封盘结算**是独立接口，不做隐式触发：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/events/:id/finalize` | `{oddPlayersPolicy: "START_PARTIAL" \| "EXTEND" \| "CANCEL"}`。人数卡在两档之间时必须显式选择，不允许服务端静默决定 |

退赛或取消时：候补顺序自动前移；已 `PUBLISHED` 阵容中的玩家不允许退赛，需管理员先 `VOID` 该场次。

## 5. 智能分组（管理员）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/matches/generate` | `{eventId, matchNo?, playerIds?, seed?}` → 创建 `DRAFT` 场次与两队 |
| GET | `/api/admin/matches/:id/lineup` | 编辑器数据：两队、每人评分/位置/契合度、总分差、位置覆盖、`version` |
| PATCH | `/api/admin/matches/:id/lineup` | `{version, moves: [{teamMemberId, toSide, toPosition}]}` |
| POST | `/api/admin/matches/:id/regenerate` | `{seed}`，仅 `DRAFT`；`version` 不变，`generation_seed` 更新 |
| POST | `/api/admin/matches/:id/publish` | 校验 10 人 / 位次唯一 / 两侧各 5 人 → 冻结快照 → `PUBLISHED` |
| POST | `/api/admin/matches/:id/void` | 流局，`VOID` |
| GET | `/api/matches/:id` | 公开阵容（发布后可见），含 `ratingGap` |

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
| GET | `/api/admin/players/:id/rating` | 三层评分 + 五项 `breakdown` + 最近修正 |
| PUT | `/api/admin/players/:id/rating-adjustment` | `{adjustment, reason, eventId?}` |
| GET | `/api/admin/players/:id/rating-adjustments` | 修正历史，倒序分页 |
| POST | `/api/admin/players/:id/rating-recompute` | 投递重算任务（改算法后使用） |

`PUT rating-adjustment` 是**幂等写**：`adjustment` 表示"新的修正值"而非增量，重复提交不会叠加。实现上必须在一个 batch 内完成：① 校验 ±limit 与原因长度 ② 更新 `player_ratings` ③ 插入 `rating_adjustments` ④ 写 `audit_logs`。任何一步失败全部回滚。

## 7. 比赛结果与数据同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/matches/:id/result` | `{dotaMatchId}` 入队 `MATCH_IMPORT`；或 `{radiantWin, durationSeconds}` 手工录入 |
| GET | `/api/admin/jobs` | outbox 健康：`PENDING` / `RUNNING` / `DEAD` 计数、最近错误、重试分布 |
| POST | `/api/admin/jobs/:id/retry` | 把 `DEAD` 任务重置为 `PENDING` |
| GET | `/api/admin/audit-logs` | `?actorId=&entityType=&from=&to=` |

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
| GET | `/api/admin/dashboard` | 赛事/玩家/报名/待发布场次汇总 |
| POST | `/api/admin/events` | 创建赛事（`title, capacity, registrationOpensAt, startsAt`） |
| PATCH | `/api/admin/events/:id` | 编辑 |
| POST | `/api/admin/events/:id/transition` | `{to: "REGISTRATION_OPEN" \| "REGISTRATION_CLOSED" \| "COMPLETED" \| "ARCHIVED" \| "CANCELLED"}` |
| GET | `/api/admin/events/:id/registrations` | 含评分、位置分布统计、候补队列 |
| POST | `/api/admin/events/:id/registrations/:rid/promote` | 候补转正 |
| PATCH | `/api/admin/users/:id/role` | 授予/撤销管理员（写审计） |

状态流转是白名单表，非法流转返回 `CONFLICT`，且每次流转写 `audit_logs`（`event.transition`，前后状态）。

## 9. 聚合与列表接口（首页 / 战绩 / 排行榜）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats/summary` | 首页四宫格：`{members, totalMatches, monthRegistrations, topPlayer}` |
| GET | `/api/matches` | `?eventId=&page=` 近期对局，按 `scheduled_at` 倒序；公开 |
| GET | `/api/me/matches` | 战绩页「我的对局」，含本人 KDA 与当场评分 |
| GET | `/api/leaderboard` | `?sort=rating\|wins\|mvp&limit=` |

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
