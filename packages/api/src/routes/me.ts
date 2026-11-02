import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, cardSkinSchema, newId, toCardSkin } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireUser } from '../guard';
import { explainRejection, normalizePositions } from '../services/positions';
import { fetchRankSnapshot } from '../services/rank-provider';
import { recomputeUserRating } from '../services/rating';
import { rankTierFromMmr } from '../algorithms/rating';

export const meRoutes = new Hono<AppEnv>();

/** player_ratings.breakdown_json 的形状（由 services/rating.ts 写入） */
interface RatingBreakdown {
  components: Array<{ key: string; weight: number; value: number; score: number; basis: string }>;
  estimatedMmr: number | null;
  attendanceBp: number | null;
  attendancePlayed?: number | null;
  attendanceRegistered?: number | null;
}

/* --------------------------------------------------------------------------
 * GET /api/me —— 档案 + 评分 + 位置偏好 + 账号绑定状态
 * ------------------------------------------------------------------------ */
meRoutes.get('/', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const user = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, role, status,
            qq_number AS qqNumber, avatar_url AS avatarUrl, bio, created_at AS createdAt,
            card_material AS cardMaterial, card_frame AS cardFrame,
            card_frame_color AS frameColor, card_frame_effect AS frameEffect
       FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<{
      cardMaterial: string;
      cardFrame: string;
      frameColor: string;
      frameEffect: string;
      [key: string]: unknown;
    }>();

  const rating = await env.DB.prepare(
    `SELECT system_rating AS system, admin_adjustment AS adjustment,
            effective_rating AS effective, confidence_bp AS confidenceBp,
            algorithm_version AS algorithmVersion, breakdown_json AS breakdownJson,
            computed_at AS computedAt, updated_at AS updatedAt
       FROM player_ratings WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{
      system: number;
      adjustment: number;
      effective: number;
      confidenceBp: number;
      algorithmVersion: string;
      breakdownJson: string | null;
      computedAt: number | null;
      updatedAt: number;
    }>();

  /**
   * 评分构成（实力分 + 出勤明细）——数据一直在 breakdown_json 里躺着，
   * 以前只写不读，玩家只能看到一个孤零零的总分。解析失败就当作没有，
   * 不能让一条脏 JSON 把整个档案接口打成 500。
   */
  let breakdown: RatingBreakdown | null = null;
  if (rating?.breakdownJson) {
    try {
      const parsed = JSON.parse(rating.breakdownJson) as RatingBreakdown;
      if (parsed && Array.isArray(parsed.components)) breakdown = parsed;
    } catch {
      breakdown = null;
    }
  }

  const positions = await env.DB.prepare(
    `SELECT position, preference_rank AS rank, proficiency
       FROM player_positions WHERE user_id = ? ORDER BY preference_rank ASC`,
  )
    .bind(userId)
    .all<{ position: number; rank: number; proficiency: number }>();

  const account = await env.DB.prepare(
    `SELECT provider, verification, dota_account_id AS dotaAccountId, persona_name AS personaName,
            last_synced_at AS lastSyncedAt
       FROM game_accounts WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{
      provider: string;
      verification: string;
      dotaAccountId: number;
      personaName: string | null;
      lastSyncedAt: number | null;
    }>();

  // 外部数据：段位、天梯分、数据来源——不返回这些，用户根本不知道"同步了什么"
  const stats = await env.DB.prepare(
    `SELECT rank_tier AS rankTier, declared_mmr AS declaredMmr, rank_source AS rankSource,
            rank_checked_at AS rankCheckedAt, career_matches AS careerMatches
       FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{
      rankTier: number | null;
      declaredMmr: number | null;
      rankSource: string | null;
      rankCheckedAt: number | null;
      careerMatches: number;
    }>();

  if (!user) throw new ApiError('NOT_FOUND', '账号不存在');
  const { cardMaterial, cardFrame, frameColor, frameEffect, ...profile } = user;

  return c.json({
    data: {
      user: profile,
      cardSkin: toCardSkin({
        material: cardMaterial,
        frame: cardFrame,
        frameColor,
        frameEffect,
      }),
      rating: rating
        ? {
            system: rating.system,
            adjustment: rating.adjustment,
            effective: rating.effective,
            confidenceBp: rating.confidenceBp,
            algorithmVersion: rating.algorithmVersion,
            computedAt: rating.computedAt,
            updatedAt: rating.updatedAt,
            breakdown,
            // 不确定度用于 UI 显示 ±N：置信度越低，展示区间越宽
            uncertainty: Math.round(300 * (1 - rating.confidenceBp / 10000)),
          }
        : null,
      positions: positions.results ?? [],
      gameAccount: account ?? null,
      stats: stats ?? null,
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * GET /api/me/rating-history —— 自己的评分调整记录
 *
 * rating_adjustments 是 append-only 的：管理员每次修正都留痕，
 * 玩家有权看到"谁、什么时候、为什么"改了自己的分。
 * ------------------------------------------------------------------------ */
meRoutes.get('/rating-history', async (c) => {
  const userId = requireUser(c);

  const rows = await c.env.DB.prepare(
    `SELECT ra.id, ra.old_adjustment AS oldAdjustment, ra.new_adjustment AS newAdjustment,
            ra.old_effective AS oldEffective, ra.new_effective AS newEffective,
            ra.reason, ra.created_at AS createdAt, u.display_name AS operatorName
       FROM rating_adjustments ra
       LEFT JOIN users u ON u.id = ra.operator_id
      WHERE ra.user_id = ?
      ORDER BY ra.created_at DESC
      LIMIT 50`,
  )
    .bind(userId)
    .all();

  return c.json({ data: { history: rows.results ?? [] }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * GET /api/me/matches —— 我的对局（战绩页）
 *
 * 只统计"正选出场 + 比赛已结束且有胜负"的场次：
 * 候补没上场不算，流局（VOID）不算。
 * 胜负由 team_side 与 matches.radiant_win 现算，不依赖 match_player_stats。
 * ------------------------------------------------------------------------ */
meRoutes.get('/matches', async (c) => {
  const userId = requireUser(c);
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;

  const rows = await c.env.DB.prepare(
    `SELECT m.id AS matchId, m.match_no AS matchNo, m.radiant_win AS radiantWin,
            m.duration_seconds AS durationSeconds, m.completed_at AS completedAt,
            m.scheduled_at AS scheduledAt,
            e.id AS eventId, e.title AS eventTitle,
            tm.team_side AS side
       FROM team_members tm
       JOIN matches m ON m.id = tm.match_id
       JOIN events e ON e.id = m.event_id
      WHERE tm.user_id = ? AND tm.is_substitute = 0
        AND m.status = 'COMPLETED' AND m.radiant_win IS NOT NULL
      ORDER BY COALESCE(m.completed_at, m.scheduled_at, m.created_at) DESC
      LIMIT ?`,
  )
    .bind(userId, limit)
    .all<{
      matchId: string;
      matchNo: number;
      radiantWin: number;
      durationSeconds: number | null;
      completedAt: number | null;
      scheduledAt: number | null;
      eventId: string;
      eventTitle: string;
      side: 'RADIANT' | 'DIRE';
    }>();

  const matches = (rows.results ?? []).map((row) => {
    const won =
      (row.side === 'RADIANT' && row.radiantWin === 1) ||
      (row.side === 'DIRE' && row.radiantWin === 0);
    return {
      matchId: row.matchId,
      matchNo: row.matchNo,
      eventId: row.eventId,
      eventTitle: row.eventTitle,
      side: row.side,
      won,
      durationSeconds: row.durationSeconds,
      playedAt: row.completedAt ?? row.scheduledAt,
    };
  });

  const wins = matches.filter((match) => match.won).length;
  const played = matches.length;

  return c.json({
    data: {
      summary: {
        played,
        wins,
        losses: played - wins,
        winRateBp: played > 0 ? Math.round((wins / played) * 10000) : null,
      },
      matches,
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * PUT /api/me/positions —— 全量覆盖位置偏好
 *
 * 用"全量替换"而不是 PATCH：志愿是一个有序集合，
 * 局部更新必然要处理重排，反而更容易出错。
 * ------------------------------------------------------------------------ */
meRoutes.put('/positions', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const body = await c.req.json().catch(() => null);
  const parsed = normalizePositions(body);
  if (!parsed.ok) {
    throw new ApiError('VALIDATION_FAILED', explainRejection(parsed.reason) ?? '位置偏好不合法');
  }

  const now = Date.now();
  const statements = [env.DB.prepare(`DELETE FROM player_positions WHERE user_id = ?`).bind(userId)];

  for (const entry of parsed.positions) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO player_positions (id, user_id, position, preference_rank, proficiency, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(newId(now), userId, entry.position, entry.rank, entry.proficiency, now),
    );
  }

  // batch 是事务：删旧插新要么全成功，要么完全不动
  await env.DB.batch(statements);

  return c.json({
    data: {
      positions: parsed.positions,
      // 下次分组才会用上新值；已发布的阵容不会因为改偏好而变化
      note: '下次生成阵容时生效',
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* --------------------------------------------------------------------------
 * PATCH /api/me —— 编辑资料
 *
 * 只允许改"自己说了算"的字段：显示名、简介、QQ。
 * 用户名是登录凭据、role 是权限、评分与段位归系统/管理员，这几样一律不接受客户端写入。
 * ------------------------------------------------------------------------ */
const patchSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  bio: z.string().trim().max(280).nullable().optional(),
  qqNumber: z
    .string()
    .trim()
    .regex(/^\d{5,12}$/, 'QQ 号应为 5-12 位数字')
    .nullable()
    .optional(),
});

meRoutes.patch('/', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const assignments: string[] = [];
  const values: unknown[] = [];
  const { displayName, bio, qqNumber } = parsed.data;

  if (displayName !== undefined) {
    assignments.push('display_name = ?');
    values.push(displayName);
  }
  if (bio !== undefined) {
    assignments.push('bio = ?');
    values.push(bio === null || bio === '' ? null : bio);
  }
  if (qqNumber !== undefined) {
    assignments.push('qq_number = ?');
    values.push(qqNumber === null || qqNumber === '' ? null : qqNumber);
  }

  if (assignments.length === 0) {
    throw new ApiError('VALIDATION_FAILED', '没有需要更新的字段');
  }

  const now = Date.now();
  assignments.push('updated_at = ?');
  values.push(now, userId);

  try {
    await env.DB.prepare(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE')) throw new ApiError('CONFLICT', '这个 QQ 号已经被其他成员使用');
    throw err;
  }

  const user = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, role, status,
            qq_number AS qqNumber, avatar_url AS avatarUrl, bio
       FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first();

  return c.json({ data: { user }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * PUT /api/me/card-skin —— 卡片外观（材质 / 边框 / 特效）
 *
 * 整份提交而不是逐项 PATCH：皮肤是"材质 + 边框 + 配色 + 光效"四件套，
 * 只改一半的语义没有意义；而且玩家每次点选都是"换一套"，整份写回最省心。
 * 这两个值只影响展示，不写审计、不重算评分、不进快照。
 * ------------------------------------------------------------------------ */
meRoutes.put('/card-skin', async (c) => {
  const userId = requireUser(c);
  const parsed = cardSkinSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '皮肤参数不合法', parsed.error.flatten().fieldErrors);
  }

  const { material, frame, frameColor, frameEffect } = parsed.data;
  await c.env.DB.prepare(
    `UPDATE users SET card_material = ?, card_frame = ?,
                      card_frame_color = ?, card_frame_effect = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(material, frame, frameColor, frameEffect, Date.now(), userId)
    .run();

  return c.json({ data: { cardSkin: parsed.data }, meta: { requestId: c.get('requestId') } });
});

/* --------------------------------------------------------------------------
 * POST /api/me/game-account/claim —— 用数字 ID 从 OpenDota 拉段位
 *
 * 语义必须说清楚：**验证的是"这个账号存在且有公开数据"，不是"这是你的账号"**。
 * 所以写入的是 verification='CLAIMED'，徽章显示"归属未验证"。
 * ------------------------------------------------------------------------ */
const claimSchema = z.object({
  accountId: z.number().int().min(1).max(4_294_967_295),
});

meRoutes.post('/game-account/claim', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '请填写数字 ID（例如 109902856）');
  }
  const accountId = parsed.data.accountId;

  // 已有 Steam 验证的账号时不允许降级成"声明"
  const existing = await env.DB.prepare(
    `SELECT id, verification FROM game_accounts WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ id: string; verification: string }>();
  if (existing?.verification === 'VERIFIED') {
    throw new ApiError('CONFLICT', '已绑定 Steam，无需再用数字 ID');
  }

  const taken = await env.DB.prepare(
    `SELECT user_id AS userId FROM game_accounts WHERE dota_account_id = ?`,
  )
    .bind(accountId)
    .first<{ userId: string }>();
  if (taken && taken.userId !== userId) {
    throw new ApiError('CONFLICT', '这个账号 ID 已经被其他成员占用');
  }

  // 段位来源：配了 STRATZ token 就走 STRATZ，否则退回 OpenDota
  // （细节与取舍见 services/rank-provider.ts）
  const snapshot = await fetchRankSnapshot(env, accountId);

  const now = Date.now();
  const rankTier = snapshot.rankTier;
  const personaname = snapshot.personaName;
  const avatar = snapshot.avatarUrl;
  /** 拿不到就是 null —— 只影响置信度，不允许它覆盖已知值 */
  const careerMatches = snapshot.careerMatches;
  const rankSource = snapshot.source;

  if (existing) {
    await env.DB.prepare(
      `UPDATE game_accounts
          SET provider = 'DOTA_ACCOUNT_ID', steam_id64 = NULL, dota_account_id = ?,
              verification = 'CLAIMED', persona_name = ?, avatar_url = ?,
              profile_url = ?, verified_at = NULL, last_synced_at = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(
        accountId,
        personaname,
        avatar,
        `https://www.opendota.com/players/${accountId}`,
        now,
        now,
        existing.id,
      )
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO game_accounts (id, user_id, provider, steam_id64, dota_account_id, verification,
         persona_name, avatar_url, profile_url, is_primary, verified_at, last_synced_at, created_at, updated_at)
       VALUES (?, ?, 'DOTA_ACCOUNT_ID', NULL, ?, 'CLAIMED', ?, ?, ?, 1, NULL, ?, ?, ?)`,
    )
      .bind(
        newId(now),
        userId,
        accountId,
        personaname,
        avatar,
        `https://www.opendota.com/players/${accountId}`,
        now,
        now,
        now,
      )
      .run();
  }

  const stats = await env.DB.prepare(
    `SELECT id, rank_source AS rankSource FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ id: string; rankSource: string | null }>();

  if (stats) {
    if (rankTier !== null) {
      // 同步到权威段位后，手填的 MMR 就该作废——留着只会和段位打架
      await env.DB.prepare(
        `UPDATE player_stats SET rank_tier = ?, declared_mmr = NULL, rank_source = ?,
                career_matches = COALESCE(?, career_matches),
                rank_checked_at = ?, fetched_at = ?, updated_at = ?
          WHERE user_id = ?`,
      )
        .bind(rankTier, rankSource, careerMatches, now, now, now, userId)
        .run();
    } else {
      // 对方没开「公开比赛数据」：这个 ID 只能用于别人去第三方核对，抓不到段位。
      // 此时绝不能像以前那样无条件覆盖 —— 那会把玩家手填的段位和 MMR 一起抹掉。
      // 只有上一次绑定同步来的段位（OPENDOTA / STRATZ）属于旧账号，必须清掉；
      // 手填（SELF_REPORTED）和管理员设定（ADMIN_SET）原样保留。
      const stale = stats.rankSource === 'OPENDOTA' || stats.rankSource === 'STRATZ';
      const staleFlag = stale ? 1 : 0;
      await env.DB.prepare(
        `UPDATE player_stats
            SET rank_tier = CASE WHEN ? THEN NULL ELSE rank_tier END,
                declared_mmr = CASE WHEN ? THEN NULL ELSE declared_mmr END,
                rank_source = CASE WHEN ? THEN 'SELF_REPORTED' ELSE rank_source END,
                career_matches = COALESCE(?, career_matches),
                fetched_at = ?,
                updated_at = ?
          WHERE user_id = ?`,
      )
        .bind(staleFlag, staleFlag, staleFlag, careerMatches, now, now, userId)
        .run();
    }
  } else {
    await env.DB.prepare(
      `INSERT INTO player_stats (id, user_id, rank_tier, rank_source, career_matches,
         rank_checked_at, fetched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, ?)`,
    )
      .bind(
        newId(now),
        userId,
        rankTier,
        rankSource,
        careerMatches,
        rankTier !== null ? now : null,
        now,
        now,
        now,
      )
      .run();
  }

  // 立刻按新数据重算，否则"拉了段位但分数没变"会让人以为失败
  const rating = await recomputeUserRating(env, userId);

  return c.json({
    data: {
      accountId,
      personaName: personaname,
      rankTier,
      careerMatches,
      hiddenData: rankTier === null,
      rating,
      note:
        rankTier === null
          ? '这个账号没开「公开比赛数据」，抓不到段位；已有的自报段位会保留。这个数字仍会显示在你的卡片上，别人去第三方平台也只能看到公开数据'
          : `段位来自 ${rankSource === 'STRATZ' ? 'STRATZ' : 'OpenDota'}；账号归属未验证，徽章会显示「归属未验证」`,
    },
  });
});

/* --------------------------------------------------------------------------
 * PUT /api/me/rank —— 手动填写段位与天梯分
 *
 * 这是"不想绑 Steam"的人的正式路径：段位由自己申报，徽章会显示"自报"，
 * 置信度按 SELF_REPORTED 计，评分随即重算（否则填了也不生效）。
 * 填了天梯分时以天梯分为准，自动折算勋章与星级。
 *
 * 优先级：上游同步（Steam / OpenDota）与管理员设定压过手填；手填只在
 * "还没有任何权威段位"时可用，详见下方守卫。
 * ------------------------------------------------------------------------ */
const rankSchema = z.object({
  /** 手选段位（勋章 × 10 + 星级）；填了天梯分时可以不填，会被天梯分覆盖 */
  rankTier: z.number().int().min(11).max(85).optional(),
  declaredMmr: z.number().int().min(0).max(20000).nullable().optional(),
});

meRoutes.put('/rank', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const parsed = rankSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const declaredMmr = parsed.data.declaredMmr ?? null;

  // 天梯分优先：填了它就按它反推段位，手选值被忽略（两者矛盾时以更具体的输入为准）
  const rankTier =
    declaredMmr !== null ? rankTierFromMmr(declaredMmr) : parsed.data.rankTier;

  if (rankTier === undefined) {
    throw new ApiError('VALIDATION_FAILED', '请填写天梯分，或手动选择一个段位');
  }

  const medal = Math.floor(rankTier / 10);
  const star = rankTier % 10;
  const validMedal = medal >= 1 && medal <= 8;
  const validStar = medal === 8 ? star === 0 : star >= 1 && star <= 5;
  if (!validMedal || !validStar) {
    throw new ApiError(
      'VALIDATION_FAILED',
      medal === 8 ? '冠绝没有星级，请只选择「冠绝」' : '星级需 1-5，勋章需 1-8',
    );
  }

  const derivedFromMmr = declaredMmr !== null;

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, rank_tier AS rankTier, rank_source AS rankSource FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ id: string; rankTier: number | null; rankSource: string | null }>();

  /**
   * 手动填写优先级最低：Steam > 数字 ID > 手填。
   *
   * 只要绑定了游戏账号（Steam 或数字 ID），段位一律以上游为准，手填直接拒绝——
   * **不看上游现在有没有抓到数据**。以前允许"上游没数据时手填"，结果是绑了 Steam 的人
   * 还能把手填值写回去，出现"挂着 Steam 验证、段位却显示自报"的自相矛盾状态。
   * 想自己填只有一条路：先解除绑定（解绑会把段位来源退回自报）。
   *
   * 管理员设定（ADMIN_SET）单独拦：那是人工判断，玩家不该一键覆盖。
   */
  const binding = await env.DB.prepare(
    `SELECT verification FROM game_accounts WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ verification: string }>();

  if (existing?.rankSource === 'ADMIN_SET') {
    throw new ApiError('CONFLICT', '当前段位由管理员设定，如需修改请联系管理员');
  }
  if (binding) {
    throw new ApiError(
      'CONFLICT',
      binding.verification === 'VERIFIED'
        ? '已绑定 Steam，段位以同步结果为准；如需手动填写请先解除绑定'
        : '已用数字 ID 声明账号，段位以同步结果为准；如需手动填写请先解除绑定',
    );
  }

  if (existing) {
    await env.DB.prepare(
      `UPDATE player_stats
          SET rank_tier = ?, declared_mmr = ?, rank_source = 'SELF_REPORTED',
              rank_checked_at = NULL, updated_at = ?
        WHERE user_id = ?`,
    )
      .bind(rankTier, declaredMmr ?? null, now, userId)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO player_stats (id, user_id, rank_tier, declared_mmr, rank_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'SELF_REPORTED', ?, ?)`,
    )
      .bind(newId(now), userId, rankTier, declaredMmr ?? null, now, now)
      .run();
  }

  // 立刻重算：不重算的话"填了段位但分数没变"会让人以为没保存成功
  const rating = await recomputeUserRating(env, userId);

  return c.json({
    data: {
      rankTier,
      declaredMmr: declaredMmr,
      derivedFromMmr,
      rating,
      note: derivedFromMmr
        ? '段位已按天梯分自动折算；段位为自报，绑定 Steam 后可验证'
        : '段位为自报，徽章会显示"自报"；绑定 Steam 后可以验证',
    },
  });
});

/* --------------------------------------------------------------------------
 * DELETE /api/me/rank —— 清空段位，回到"没有实力数据"的初始状态
 *
 * 只允许清掉**自己填的**（SELF_REPORTED）：
 *   · 同步来的段位属于那个 Dota 账号，抹掉它不会让账号消失，下次同步又回来；
 *   · 管理员设定的段位属于管理判断，玩家不该一键推翻。
 * 想清掉同步段位只有一条路：先解绑（解绑本身就会把段位来源退回自报/清空）。
 *
 * 清空后立刻重算评分——没有段位/MMR 时是 500 中性值，置信度归零。
 * 报名时也会被当成「没有段位」，按上一轮定的规则排在有段位的玩家之后。
 * ------------------------------------------------------------------------ */
meRoutes.delete('/rank', async (c) => {
  const userId = requireUser(c);
  const env = c.env;

  const existing = await env.DB.prepare(
    `SELECT rank_tier AS rankTier, declared_mmr AS declaredMmr, rank_source AS rankSource
       FROM player_stats WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ rankTier: number | null; declaredMmr: number | null; rankSource: string | null }>();

  // 本来就没段位：幂等返回，前端不必为"清了个空"报错
  if (!existing || (existing.rankTier === null && existing.declaredMmr === null)) {
    const rating = await recomputeUserRating(env, userId);
    return c.json({
      data: { cleared: false, rankTier: null, declaredMmr: null, rating },
      meta: { requestId: c.get('requestId') },
    });
  }

  if (existing.rankSource === 'ADMIN_SET') {
    throw new ApiError('CONFLICT', '当前段位由管理员设定，如需清空请联系管理员');
  }
  if (existing.rankSource === 'OPENDOTA' || existing.rankSource === 'STRATZ') {
    throw new ApiError('CONFLICT', '段位来自账号同步，先解除绑定才能清空');
  }

  await env.DB.prepare(
    `UPDATE player_stats
        SET rank_tier = NULL, declared_mmr = NULL, rank_source = NULL,
            rank_checked_at = NULL, updated_at = ?
      WHERE user_id = ?`,
  )
    .bind(Date.now(), userId)
    .run();

  const rating = await recomputeUserRating(env, userId);

  return c.json({
    data: { cleared: true, rankTier: null, declaredMmr: null, rating },
    meta: { requestId: c.get('requestId') },
  });
});
