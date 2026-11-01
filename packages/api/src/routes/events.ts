import { Hono } from 'hono';
import { ApiError, newId, toCardSkin } from '@hive/shared';
import type { AppEnv, Env } from '../env';
import { requireUser } from '../guard';
import { MATCH_SIZE, slotsToNextMatch, targetMatches } from '../services/roster';

export const eventRoutes = new Hono<AppEnv>();

export interface EventRow {
  id: string;
  title: string;
  summary: string | null;
  format: string;
  team_size: number;
  capacity: number;
  status: string;
  registration_opens_at: number | null;
  registration_closes_at: number | null;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RegistrationCounts {
  confirmed: number;
  waitlist: number;
}

const EVENT_COLUMNS = `id, title, summary, format, team_size, capacity, status,
  registration_opens_at, registration_closes_at, starts_at, ends_at, created_at, updated_at`;

export async function loadEvent(env: Env, eventId: string): Promise<EventRow> {
  const row = await env.DB.prepare(`SELECT ${EVENT_COLUMNS} FROM events WHERE id = ?`)
    .bind(eventId)
    .first<EventRow>();
  if (!row) throw new ApiError('NOT_FOUND', '赛事不存在');
  return row;
}

export async function countRegistrations(env: Env, eventId: string): Promise<RegistrationCounts> {
  const rows = await env.DB.prepare(
    `SELECT status, count(*) AS c FROM registrations WHERE event_id = ? GROUP BY status`,
  )
    .bind(eventId)
    .all<{ status: string; c: number }>();

  const counts: RegistrationCounts = { confirmed: 0, waitlist: 0 };
  for (const row of rows.results ?? []) {
    if (row.status === 'CONFIRMED') counts.confirmed = row.c;
    if (row.status === 'WAITLIST') counts.waitlist = row.c;
  }
  return counts;
}

/** 对外暴露的赛事视图：把派生字段算好，前端不重复计算 */
export function toEventView(event: EventRow, counts: RegistrationCounts) {
  return {
    id: event.id,
    title: event.title,
    summary: event.summary,
    format: event.format,
    teamSize: event.team_size,
    capacity: event.capacity,
    status: event.status,
    targetMatches: targetMatches(event.capacity),
    confirmed: counts.confirmed,
    waitlist: counts.waitlist,
    slotsToNextMatch: slotsToNextMatch(counts.confirmed, event.capacity),
    registrationOpensAt: event.registration_opens_at,
    registrationClosesAt: event.registration_closes_at,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
  };
}

/* -------------------------------------------------------------------------- */

eventRoutes.get('/', async (c) => {
  const status = c.req.query('status');
  const sql = status
    ? `SELECT ${EVENT_COLUMNS} FROM events WHERE status = ? ORDER BY starts_at DESC, created_at DESC LIMIT 50`
    : `SELECT ${EVENT_COLUMNS} FROM events ORDER BY starts_at DESC, created_at DESC LIMIT 50`;
  const stmt = status ? c.env.DB.prepare(sql).bind(status) : c.env.DB.prepare(sql);
  const rows = await stmt.all<EventRow>();

  // DRAFT 对普通玩家不可见
  const visible = (rows.results ?? []).filter(
    (event) => c.get('role') === 'ADMIN' || event.status !== 'DRAFT',
  );

  const data = await Promise.all(
    visible.map(async (event) => toEventView(event, await countRegistrations(c.env, event.id))),
  );

  return c.json({ data, meta: { requestId: c.get('requestId') } });
});

eventRoutes.get('/:id', async (c) => {
  const event = await loadEvent(c.env, c.req.param('id'));
  if (event.status === 'DRAFT' && c.get('role') !== 'ADMIN') {
    throw new ApiError('NOT_FOUND', '赛事不存在');
  }

  const counts = await countRegistrations(c.env, event.id);
  const userId = c.get('userId');

  // 只返回"仍然有效"的报名。已退赛的行必须过滤掉，
  // 否则前端会把 WITHDRAWN 当成"我还报着名"，退赛按钮也就一直挂着。
  const mine = userId
    ? await c.env.DB.prepare(
        `SELECT id, status, position_preference AS positionPreference,
                waitlist_position AS waitlistPosition, created_at AS createdAt
           FROM registrations
          WHERE event_id = ? AND user_id = ? AND status IN ('CONFIRMED', 'WAITLIST')`,
      )
        .bind(event.id, userId)
        .first()
    : null;

  return c.json({
    data: { event: toEventView(event, counts), myRegistration: mine ?? null },
    meta: { requestId: c.get('requestId') },
  });
});

/** 赛事下的场次列表。管理员能看到 DRAFT，玩家只看已发布的 */
eventRoutes.get('/:id/matches', async (c) => {
  const event = await loadEvent(c.env, c.req.param('id'));
  const isAdmin = c.get('role') === 'ADMIN';

  if (event.status === 'DRAFT' && !isAdmin) throw new ApiError('NOT_FOUND', '赛事不存在');

  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.match_no AS matchNo, m.title, m.status, m.rating_gap AS ratingGap,
            m.published_at AS publishedAt, m.version, m.generation_seed AS seed,
            (SELECT count(*) FROM team_members tm
              WHERE tm.match_id = m.id AND tm.is_substitute = 0) AS memberCount
       FROM matches m
      WHERE m.event_id = ?
      ORDER BY m.match_no ASC`,
  )
    .bind(event.id)
    .all();

  const list = (rows.results ?? []).filter((row) => isAdmin || row.status !== 'DRAFT');

  return c.json({ data: list, meta: { requestId: c.get('requestId') } });
});

/**
 * 公开的报名名单（玩家卡片数据源）。
 *
 * 只暴露展示所需字段：昵称、简介、位置、段位、MMR、WARROOM 评分、验证等级。
 * 不返回邮箱、QQ、SteamID64 —— 卡片要好看，但没必要把身份信息全抖出来。
 */
eventRoutes.get('/:id/registrations', async (c) => {
  const event = await loadEvent(c.env, c.req.param('id'));
  if (event.status === 'DRAFT' && c.get('role') !== 'ADMIN') {
    throw new ApiError('NOT_FOUND', '赛事不存在');
  }

  const rows = await c.env.DB.prepare(
    `SELECT r.user_id AS userId, r.status,
            COALESCE(r.position_preference, pp.position) AS position,
            u.display_name AS displayName, u.bio,
            u.card_material AS cardMaterial, u.card_frame AS cardFrame,
            ps.rank_tier AS rankTier, ps.declared_mmr AS declaredMmr,
            pr.effective_rating AS rating,
            ga.verification AS accountVerification, ga.persona_name AS personaName
       FROM registrations r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN player_stats ps ON ps.user_id = r.user_id
       LEFT JOIN player_ratings pr ON pr.user_id = r.user_id
       LEFT JOIN game_accounts ga ON ga.user_id = r.user_id
       LEFT JOIN player_positions pp ON pp.user_id = r.user_id AND pp.preference_rank = 1
      WHERE r.event_id = ? AND r.status IN ('CONFIRMED', 'WAITLIST')
      ORDER BY CASE r.status WHEN 'CONFIRMED' THEN 0 ELSE 1 END,
               COALESCE(pr.effective_rating, 500) DESC, r.created_at ASC`,
  )
    .bind(event.id)
    .all<{
      userId: string;
      status: string;
      position: number | null;
      displayName: string;
      bio: string | null;
      cardMaterial: string;
      cardFrame: string;
      rankTier: number | null;
      declaredMmr: number | null;
      rating: number | null;
      accountVerification: string | null;
      personaName: string | null;
    }>();

  const players = (rows.results ?? []).map((row) => {
    // 徽章由"账号归属可信"与"段位是否抓到"两件事派生
    let verification: 'VERIFIED' | 'VERIFIED_NO_DATA' | 'CLAIMED' | 'SELF_REPORTED' = 'SELF_REPORTED';
    if (row.accountVerification === 'VERIFIED') {
      verification = row.rankTier !== null ? 'VERIFIED' : 'VERIFIED_NO_DATA';
    } else if (row.accountVerification === 'CLAIMED') {
      verification = 'CLAIMED';
    }

    return {
      userId: row.userId,
      status: row.status,
      displayName: row.displayName,
      bio: row.bio,
      position: row.position,
      rankTier: row.rankTier,
      declaredMmr: row.declaredMmr,
      rating: row.rating,
      verification,
      personaName: row.personaName,
      // 卡片外观跟着人走：别人看到的永远是玩家自己选的那套皮肤
      skin: toCardSkin({
        material: row.cardMaterial,
        frame: row.cardFrame,
      }),
    };
  });

  return c.json({
    data: { event: toEventView(event, await countRegistrations(c.env, event.id)), players },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * 报名：写入四个快照字段，之后管理员改评分不得回写
 * ------------------------------------------------------------------------ */
eventRoutes.post('/:id/registrations', async (c) => {
  const env = c.env;
  const userId = requireUser(c);
  const event = await loadEvent(env, c.req.param('id'));
  const now = Date.now();

  if (event.status !== 'REGISTRATION_OPEN') {
    throw new ApiError('CONFLICT', '当前不在报名阶段');
  }
  if (event.registration_opens_at !== null && now < event.registration_opens_at) {
    throw new ApiError('CONFLICT', '报名尚未开始');
  }
  if (event.registration_closes_at !== null && now > event.registration_closes_at) {
    throw new ApiError('CONFLICT', '报名已截止');
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    positionPreference?: number;
    secondaryPosition?: number;
    note?: string;
  };
  const positionPreference = clampPosition(body.positionPreference);
  const secondaryPosition = clampPosition(body.secondaryPosition);
  if (secondaryPosition !== null && secondaryPosition === positionPreference) {
    throw new ApiError('VALIDATION_FAILED', '主位置与次位置不能相同');
  }

  // ---- 评分与位置的快照 ----
  const rating = await env.DB.prepare(
    `SELECT system_rating AS system, admin_adjustment AS adjustment, effective_rating AS effective
       FROM player_ratings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ system: number; adjustment: number; effective: number }>();

  const positionRows = await env.DB.prepare(
    `SELECT position, preference_rank AS rank, proficiency
       FROM player_positions WHERE user_id = ? ORDER BY preference_rank ASC`,
  )
    .bind(userId)
    .all<{ position: number; rank: number; proficiency: number }>();

  // 位置快照：优先用玩家档案里的完整偏好；档案为空时，至少要把本次报名提交的志愿写进去，
  // 否则分组算法拿到的是一份空偏好，会把所有人当成"什么位置都不熟"。
  const profile = positionRows.results ?? [];
  const positions =
    profile.length > 0
      ? profile
      : [
          ...(positionPreference !== null
            ? [{ position: positionPreference, rank: 1, proficiency: 50 }]
            : []),
          ...(secondaryPosition !== null
            ? [{ position: secondaryPosition, rank: 2, proficiency: 50 }]
            : []),
        ];

  const snapshot = {
    system: rating?.system ?? 500,
    adjustment: rating?.adjustment ?? 0,
    effective: rating?.effective ?? 500,
    positions,
  };

  const counts = await countRegistrations(env, event.id);

  // ---- 复用或新建报名行（退赛后重新报名复用同一行，唯一索引只允许一行）----
  const existing = await env.DB.prepare(
    `SELECT id, status FROM registrations WHERE event_id = ? AND user_id = ?`,
  )
    .bind(event.id, userId)
    .first<{ id: string; status: string }>();

  if (existing && (existing.status === 'CONFIRMED' || existing.status === 'WAITLIST')) {
    throw new ApiError('CONFLICT', '你已经报名了');
  }

  const full = counts.confirmed >= event.capacity;
  const status = full ? 'WAITLIST' : 'CONFIRMED';
  const waitlistPosition = full ? counts.waitlist + 1 : null;
  const id = existing?.id ?? newId(now);

  if (existing) {
    await env.DB.prepare(
      `UPDATE registrations
          SET status = ?, position_preference = ?, secondary_position = ?,
              system_rating_snapshot = ?, admin_adjustment_snapshot = ?, effective_rating_snapshot = ?,
              position_snapshot = ?, snapshot_at = ?, waitlist_position = ?, note = ?,
              withdrawn_at = NULL, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        status,
        positionPreference,
        secondaryPosition,
        snapshot.system,
        snapshot.adjustment,
        snapshot.effective,
        JSON.stringify(snapshot.positions),
        now,
        waitlistPosition,
        body.note?.slice(0, 140) ?? null,
        now,
        id,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO registrations (
         id, event_id, user_id, status, position_preference, secondary_position,
         system_rating_snapshot, admin_adjustment_snapshot, effective_rating_snapshot,
         position_snapshot, snapshot_at, waitlist_position, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        event.id,
        userId,
        status,
        positionPreference,
        secondaryPosition,
        snapshot.system,
        snapshot.adjustment,
        snapshot.effective,
        JSON.stringify(snapshot.positions),
        now,
        waitlistPosition,
        body.note?.slice(0, 140) ?? null,
        now,
        now,
      )
      .run();
  }

  const after = await countRegistrations(env, event.id);

  return c.json(
    {
      data: {
        registration: {
          id,
          status,
          waitlistPosition,
          effectiveRatingSnapshot: snapshot.effective,
        },
        event: toEventView(event, after),
      },
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
});

/* --------------------------------------------------------------------------
 * 退赛：只允许在报名阶段；已发布阵容里的玩家必须由管理员先 VOID 场次
 * ------------------------------------------------------------------------ */
eventRoutes.delete('/:id/registrations', async (c) => {
  const env = c.env;
  const userId = requireUser(c);
  const event = await loadEvent(env, c.req.param('id'));

  if (event.status !== 'REGISTRATION_OPEN') {
    throw new ApiError('CONFLICT', '当前不在报名阶段，无法退赛');
  }

  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE registrations SET status = 'WITHDRAWN', withdrawn_at = ?, waitlist_position = NULL, updated_at = ?
      WHERE event_id = ? AND user_id = ? AND status IN ('CONFIRMED', 'WAITLIST')`,
  )
    .bind(now, now, event.id, userId)
    .run();

  if (!result.meta.changes) throw new ApiError('NOT_FOUND', '没有可退的报名');

  return c.json({
    data: { event: toEventView(event, await countRegistrations(env, event.id)) },
    meta: { requestId: c.get('requestId') },
  });
});

function clampPosition(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 5 ? value : null;
}

export { MATCH_SIZE };
