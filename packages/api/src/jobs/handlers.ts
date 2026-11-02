/**
 * 任务处理器：每种 kind 一个函数，队列只负责调度与重试。
 *
 * 这里刻意不做业务判断（谁能改、改了要不要审计）——那是路由层的职责；
 * 队列里的任务都来自已经过校验的入口。
 */
import type { Env } from '../env';
import { fetchRankSnapshot } from '../services/rank-provider';
import { recomputeUserRating } from '../services/rating';
import { newId } from '@hive/shared';

interface RatingPayload {
  userId: string;
}

interface SyncPayload {
  userId: string;
}

/**
 * 从段位源（STRATZ 优先，OpenDota 兜底）拉这个玩家的段位与累计场次；
 * 失败就抛，让队列按退避重试。
 */
async function syncPlayerStats(env: Env, userId: string): Promise<void> {
  const account = await env.DB.prepare(
    `SELECT dota_account_id AS dotaAccountId FROM game_accounts WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ dotaAccountId: number }>();

  if (!account) return; // 没绑游戏账号，没什么可同步的

  const id = account.dotaAccountId;
  const snapshot = await fetchRankSnapshot(env, id);

  const rankTier = snapshot.rankTier;
  /** null = 这次没拿到（STRATZ 路径不取场次），不允许它覆盖已有值 */
  const careerMatches = snapshot.careerMatches;
  const rankSource = snapshot.source;
  const now = Date.now();

  const existing = await env.DB.prepare(`SELECT id FROM player_stats WHERE user_id = ?`)
    .bind(userId)
    .first<{ id: string }>();

  if (existing) {
    // 只有真的抓到段位才覆盖；抓不到（没开公开数据）就只更新场次，别把已有段位抹掉
    if (rankTier !== null) {
      await env.DB.prepare(
        `UPDATE player_stats SET rank_tier = ?, declared_mmr = NULL, rank_source = ?,
           career_matches = COALESCE(?, career_matches),
           rank_checked_at = ?, fetched_at = ?, updated_at = ?
         WHERE user_id = ?`,
      )
        .bind(rankTier, rankSource, careerMatches, now, now, now, userId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE player_stats SET career_matches = COALESCE(?, career_matches),
           fetched_at = ?, updated_at = ?
          WHERE user_id = ?`,
      )
        .bind(careerMatches, now, now, userId)
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

  // 段位/样本变了，分数必须跟着变
  await recomputeUserRating(env, userId);
}

export async function handleJob(env: Env, kind: string, payloadJson: string): Promise<void> {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;

  switch (kind) {
    case 'RATING_RECOMPUTE': {
      const { userId } = payload as unknown as RatingPayload;
      if (!userId) throw new Error('RATING_RECOMPUTE 缺少 userId');
      await recomputeUserRating(env, userId);
      return;
    }
    case 'PLAYER_SYNC': {
      const { userId } = payload as unknown as SyncPayload;
      if (!userId) throw new Error('PLAYER_SYNC 缺少 userId');
      await syncPlayerStats(env, userId);
      return;
    }
    case 'MATCH_IMPORT':
      // 对局导入要写 match_player_stats（10 人 × 十几个字段），还没做。
      // 抛错让它走重试 → DEAD，至少不会静默丢任务。
      throw new Error('MATCH_IMPORT 尚未实现（需要 OpenDota 对局导入）');
    default:
      throw new Error(`未知任务类型：${kind}`);
  }
}
