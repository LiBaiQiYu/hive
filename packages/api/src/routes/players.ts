/**
 * 玩家公开主页：档案 + 战绩 + 点赞点踩 + 留言板。
 *
 * 这是本项目第一个"别人也能写东西"的接口面，所以几条规矩先立在这里：
 *   · 只暴露展示所需字段：昵称、简介、位置、段位、MMR、评分、验证等级、DOTA ID。
 *     邮箱、QQ、SteamID64 一律不返回（和报名名单的口径保持一致）。
 *   · 写操作全部要求登录；点赞点踩一人一票，可切换、可取消，不能投自己。
 *   · 留言两级封顶（一级 + 回复），删除是软删除——否则回复会变成孤儿。
 *   · 评论限长 1000 字，并且有"每人每分钟最多 6 条"的粗粒度防洪。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireUser } from '../guard';
import { countNoShows, listNoShows } from '../services/attendance';

export const playerRoutes = new Hono<AppEnv>();

/** 评论防洪：同一用户一分钟内最多发几条 */
const COMMENTS_PER_MINUTE = 6;
const MAX_COMMENT_LENGTH = 1000;

/* -------------------------------------------------------------------------- */
/* 公开档案                                                                    */
/* -------------------------------------------------------------------------- */

interface ProfileRow {
  userId: string;
  username: string;
  displayName: string;
  bio: string | null;
  createdAt: number;
  position: number | null;
  rankTier: number | null;
  declaredMmr: number | null;
  rankSource: string | null;
  rating: number | null;
  cardMaterial: string;
  cardFrame: string;
  frameColor: string;
  frameEffect: string;
  accountVerification: string | null;
  personaName: string | null;
  dotaAccountId: number | null;
}

playerRoutes.get('/:id', async (c) => {
  const env = c.env;
  const targetId = c.req.param('id');
  const viewerId = c.get('userId');

  const row = await env.DB.prepare(
    `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.bio,
            u.created_at AS createdAt,
            u.card_material AS cardMaterial, u.card_frame AS cardFrame,
            u.card_frame_color AS frameColor, u.card_frame_effect AS frameEffect,
            pp.position,
            ps.rank_tier AS rankTier, ps.declared_mmr AS declaredMmr, ps.rank_source AS rankSource,
            pr.effective_rating AS rating,
            ga.verification AS accountVerification, ga.persona_name AS personaName,
            ga.dota_account_id AS dotaAccountId
       FROM users u
       LEFT JOIN player_stats ps ON ps.user_id = u.id
       LEFT JOIN player_ratings pr ON pr.user_id = u.id
       LEFT JOIN game_accounts ga ON ga.user_id = u.id
       LEFT JOIN player_positions pp ON pp.user_id = u.id AND pp.preference_rank = 1
      WHERE u.id = ? AND u.status = 'ACTIVE'`,
  )
    .bind(targetId)
    .first<ProfileRow>();

  if (!row) throw new ApiError('NOT_FOUND', '这个玩家不存在');

  // 徽章由"账号归属可信"与"段位是否抓到"两件事派生（与报名名单同口径）
  let verification: 'VERIFIED' | 'VERIFIED_NO_DATA' | 'CLAIMED' | 'SELF_REPORTED' = 'SELF_REPORTED';
  if (row.accountVerification === 'VERIFIED') {
    verification = row.rankTier !== null ? 'VERIFIED' : 'VERIFIED_NO_DATA';
  } else if (row.accountVerification === 'CLAIMED') {
    verification = 'CLAIMED';
  }

  /* 战绩：只算"正选出场 + 已结束且有胜负"的场次（与 /api/me/matches 同口径） */
  const matchRows = await env.DB.prepare(
    `SELECT m.id AS matchId, m.match_no AS matchNo, m.radiant_win AS radiantWin,
            m.duration_seconds AS durationSeconds, m.completed_at AS completedAt,
            m.scheduled_at AS scheduledAt,
            e.id AS eventId, e.title AS eventTitle, tm.team_side AS side
       FROM team_members tm
       JOIN matches m ON m.id = tm.match_id
       JOIN events e ON e.id = m.event_id
      WHERE tm.user_id = ? AND tm.is_substitute = 0
        AND m.status = 'COMPLETED' AND m.radiant_win IS NOT NULL
      ORDER BY COALESCE(m.completed_at, m.scheduled_at, m.created_at) DESC
      LIMIT 30`,
  )
    .bind(row.userId)
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

  const matches = (matchRows.results ?? []).map((item) => ({
    matchId: item.matchId,
    matchNo: item.matchNo,
    eventId: item.eventId,
    eventTitle: item.eventTitle,
    side: item.side,
    won:
      (item.side === 'RADIANT' && item.radiantWin === 1) ||
      (item.side === 'DIRE' && item.radiantWin === 0),
    durationSeconds: item.durationSeconds,
    playedAt: item.completedAt ?? item.scheduledAt,
  }));

  const wins = matches.filter((match) => match.won).length;
  const played = matches.length;

  /* 弃赛：报名了、进了正选，但没来被换下去的场次（只展示，不进胜负） */
  const noShows = await countNoShows(env, row.userId);
  const noShowMatches = await listNoShows(env, row.userId, 10);

  /* 点赞点踩：总数 + 自己投过什么 */
  const reactionRow = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM player_reactions WHERE target_user_id = ?1 AND kind = 'LIKE') AS likes,
       (SELECT count(*) FROM player_reactions WHERE target_user_id = ?1 AND kind = 'DISLIKE') AS dislikes,
       (SELECT kind FROM player_reactions WHERE target_user_id = ?1 AND actor_id = ?2) AS mine`,
  )
    .bind(row.userId, viewerId ?? '')
    .first<{ likes: number; dislikes: number; mine: string | null }>();

  return c.json({
    data: {
      player: {
        userId: row.userId,
        username: row.username,
        displayName: row.displayName,
        bio: row.bio,
        joinedAt: row.createdAt,
        position: row.position,
        rankTier: row.rankTier,
        declaredMmr: row.declaredMmr,
        rankSource: row.rankSource,
        rating: row.rating,
        verification,
        personaName: row.personaName,
        dotaAccountId: row.dotaAccountId,
        skin: {
          material: row.cardMaterial,
          frame: row.cardFrame,
          frameColor: row.frameColor,
          frameEffect: row.frameEffect,
        },
      },
      summary: {
        played,
        wins,
        losses: played - wins,
        winRateBp: played > 0 ? Math.round((wins / played) * 10000) : null,
        /** 报名后未到场（被替补顶下来）的场次；计入出勤率的不出场，不计入胜负 */
        noShows,
      },
      noShowMatches,
      matches,
      reactions: {
        likes: reactionRow?.likes ?? 0,
        dislikes: reactionRow?.dislikes ?? 0,
        mine: reactionRow?.mine ?? null,
      },
      /** 是不是在看自己的主页（前端据此隐藏"给自己投票"等动作） */
      isSelf: viewerId === row.userId,
    },
    meta: { requestId: c.get('requestId') },
  });
});

/* -------------------------------------------------------------------------- */
/* 点赞 / 点踩                                                                 */
/* -------------------------------------------------------------------------- */

const reactionSchema = z.object({
  kind: z.enum(['LIKE', 'DISLIKE']).nullable(),
});

playerRoutes.post('/:id/reaction', async (c) => {
  const actorId = requireUser(c);
  const env = c.env;
  const targetId = c.req.param('id');

  const parsed = reactionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '只能点赞、点踩或取消');
  }
  if (targetId === actorId) {
    throw new ApiError('FORBIDDEN', '不能给自己投票');
  }

  const target = await env.DB.prepare(
    `SELECT id FROM users WHERE id = ? AND status = 'ACTIVE'`,
  )
    .bind(targetId)
    .first<{ id: string }>();
  if (!target) throw new ApiError('NOT_FOUND', '这个玩家不存在');

  const now = Date.now();
  const existing = await env.DB.prepare(
    `SELECT id, kind FROM player_reactions WHERE actor_id = ? AND target_user_id = ?`,
  )
    .bind(actorId, targetId)
    .first<{ id: string; kind: string }>();

  if (parsed.data.kind === null) {
    if (existing) {
      await env.DB.prepare(`DELETE FROM player_reactions WHERE id = ?`).bind(existing.id).run();
    }
  } else if (existing) {
    // 再点同一个按钮 = 取消；换另一个 = 改票
    if (existing.kind === parsed.data.kind) {
      await env.DB.prepare(`DELETE FROM player_reactions WHERE id = ?`).bind(existing.id).run();
    } else {
      await env.DB.prepare(
        `UPDATE player_reactions SET kind = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(parsed.data.kind, now, existing.id)
        .run();
    }
  } else {
    await env.DB.prepare(
      `INSERT INTO player_reactions (id, target_user_id, actor_id, kind, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(newId(now), targetId, actorId, parsed.data.kind, now, now)
      .run();
  }

  const tally = await env.DB.prepare(
    `SELECT
       (SELECT count(*) FROM player_reactions WHERE target_user_id = ?1 AND kind = 'LIKE') AS likes,
       (SELECT count(*) FROM player_reactions WHERE target_user_id = ?1 AND kind = 'DISLIKE') AS dislikes,
       (SELECT kind FROM player_reactions WHERE target_user_id = ?1 AND actor_id = ?2) AS mine`,
  )
    .bind(targetId, actorId)
    .first<{ likes: number; dislikes: number; mine: string | null }>();

  return c.json({
    data: { likes: tally?.likes ?? 0, dislikes: tally?.dislikes ?? 0, mine: tally?.mine ?? null },
    meta: { requestId: c.get('requestId') },
  });
});

/* -------------------------------------------------------------------------- */
/* 留言板                                                                      */
/* -------------------------------------------------------------------------- */

interface CommentRow {
  id: string;
  parentId: string | null;
  body: string;
  deletedAt: number | null;
  createdAt: number;
  authorId: string;
  authorName: string;
  authorUsername: string;
  likeCount: number;
  likedByMe: number;
}

/** 一条查询取评论 + 作者 + 点赞数 + 我是否点过（viewerId 为空串时 likedByMe 恒为 0） */
const COMMENT_COLUMNS = `c.id, c.parent_id AS parentId, c.body, c.deleted_at AS deletedAt,
            c.created_at AS createdAt, c.author_id AS authorId,
            u.display_name AS authorName, u.username AS authorUsername,
            (SELECT count(*) FROM comment_likes cl WHERE cl.comment_id = c.id) AS likeCount,
            EXISTS(SELECT 1 FROM comment_likes cl2 WHERE cl2.comment_id = c.id AND cl2.user_id = ?2) AS likedByMe`;

function shapeComment(row: CommentRow) {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    parentId: row.parentId,
    // 软删除后不返回原文：删掉的留言不该还能被读到
    body: deleted ? '' : row.body,
    deleted,
    createdAt: row.createdAt,
    author: {
      id: row.authorId,
      displayName: row.authorName,
      username: row.authorUsername,
    },
    // 墓碑只是给对话留个位置，点赞数没有意义
    likeCount: deleted ? 0 : row.likeCount,
    likedByMe: deleted ? false : row.likedByMe === 1,
  };
}

playerRoutes.get('/:id/comments', async (c) => {
  const env = c.env;
  const targetId = c.req.param('id');
  const viewerId = c.get('userId') ?? '';

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;

  const rootRows = await env.DB.prepare(
    `SELECT ${COMMENT_COLUMNS}
       FROM comments c JOIN users u ON u.id = c.author_id
      WHERE c.target_user_id = ?1 AND c.parent_id IS NULL
      ORDER BY c.created_at DESC
      LIMIT ${limit}`,
  )
    .bind(targetId, viewerId)
    .all<CommentRow>();

  const roots = rootRows.results ?? [];
  let replies: CommentRow[] = [];
  if (roots.length > 0) {
    const placeholders = roots.map(() => '?').join(', ');
    const replyRows = await env.DB.prepare(
      `SELECT ${COMMENT_COLUMNS}
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.target_user_id = ?1 AND c.parent_id IN (${placeholders})
        ORDER BY c.created_at ASC`,
    )
      .bind(targetId, viewerId, ...roots.map((row) => row.id))
      .all<CommentRow>();
    replies = replyRows.results ?? [];
  }

  const repliesByParent = new Map<string, CommentRow[]>();
  for (const reply of replies) {
    if (!reply.parentId) continue;
    const list = repliesByParent.get(reply.parentId) ?? [];
    list.push(reply);
    repliesByParent.set(reply.parentId, list);
  }

  /**
   * 删除后的留言只当"路标"，不是内容：
   *   · 回复没有下级，删了直接不返回；
   *   · 一级评论只有**还留着存活回复**时才留墓碑，否则整条隐藏——
   *     删掉的留言还挂在墙上显示"该留言已删除"，看着像系统坏了。
   */
  const threads = roots
    .map((root) => ({
      root,
      alive: (repliesByParent.get(root.id) ?? []).filter((reply) => reply.deletedAt === null),
    }))
    .filter((item) => item.root.deletedAt === null || item.alive.length > 0)
    .map((item) => ({
      ...shapeComment(item.root),
      replies: item.alive.map(shapeComment),
    }));

  return c.json({
    data: { threads },
    meta: { requestId: c.get('requestId') },
  });
});

const commentSchema = z.object({
  body: z.string().trim().min(1, '留言不能为空').max(MAX_COMMENT_LENGTH, `最多 ${MAX_COMMENT_LENGTH} 字`),
  parentId: z.string().uuid().nullable().optional(),
});

playerRoutes.post('/:id/comments', async (c) => {
  const authorId = requireUser(c);
  const env = c.env;
  const targetId = c.req.param('id');

  const parsed = commentSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', parsed.error.issues[0]?.message ?? '输入不合法');
  }
  const body = parsed.data.body.trim();

  const target = await env.DB.prepare(
    `SELECT id FROM users WHERE id = ? AND status = 'ACTIVE'`,
  )
    .bind(targetId)
    .first<{ id: string }>();
  if (!target) throw new ApiError('NOT_FOUND', '这个玩家不存在');

  // 回复只允许两级：回复"回复"时自动挂到同一个根上
  let parentId: string | null = null;
  if (parsed.data.parentId) {
    const parent = await env.DB.prepare(
      `SELECT id, parent_id AS parentId, target_user_id AS targetUserId, deleted_at AS deletedAt
         FROM comments WHERE id = ?`,
    )
      .bind(parsed.data.parentId)
      .first<{ id: string; parentId: string | null; targetUserId: string; deletedAt: number | null }>();

    if (!parent || parent.targetUserId !== targetId) {
      throw new ApiError('NOT_FOUND', '要回复的留言不存在');
    }
    if (parent.deletedAt !== null) {
      throw new ApiError('CONFLICT', '这条留言已被删除，不能再回复');
    }
    parentId = parent.parentId ?? parent.id;
  }

  // 粗粒度防洪：一分钟内发太多直接挡
  const recent = await env.DB.prepare(
    `SELECT count(*) AS n FROM comments WHERE author_id = ? AND created_at > ?`,
  )
    .bind(authorId, Date.now() - 60 * 1000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= COMMENTS_PER_MINUTE) {
    throw new ApiError('RATE_LIMITED', '发言太快了，歇一分钟再来');
  }

  const now = Date.now();
  const id = newId(now);
  await env.DB.prepare(
    `INSERT INTO comments (id, target_user_id, author_id, parent_id, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, targetId, authorId, parentId, body, now, now)
    .run();

  return c.json(
    {
      data: {
        id,
        parentId,
        body,
        createdAt: now,
        authorId,
      },
      meta: { requestId: c.get('requestId') },
    },
    201,
  );
});

/** 删留言：作者本人或管理员；软删除，回复保留位置 */
playerRoutes.delete('/:id/comments/:commentId', async (c) => {
  const actorId = requireUser(c);
  const env = c.env;
  const targetId = c.req.param('id');
  const commentId = c.req.param('commentId');

  const row = await env.DB.prepare(
    `SELECT id, author_id AS authorId, target_user_id AS targetUserId, deleted_at AS deletedAt
       FROM comments WHERE id = ?`,
  )
    .bind(commentId)
    .first<{ id: string; authorId: string; targetUserId: string; deletedAt: number | null }>();

  if (!row || row.targetUserId !== targetId) {
    throw new ApiError('NOT_FOUND', '留言不存在');
  }
  if (row.deletedAt !== null) {
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  }

  const isAuthor = row.authorId === actorId;
  const isAdmin = c.get('role') === 'ADMIN';
  if (!isAuthor && !isAdmin) throw new ApiError('FORBIDDEN', '只能删自己的留言');

  await env.DB.batch([
    env.DB.prepare(`UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(
      Date.now(),
      Date.now(),
      commentId,
    ),
    // 删掉的留言不再有"点赞"这回事，顺手清干净，别留一堆指向墓碑的赞
    env.DB.prepare(`DELETE FROM comment_likes WHERE comment_id = ?`).bind(commentId),
  ]);

  return c.json({
    data: { ok: true, deletedByAdmin: !isAuthor && isAdmin },
    meta: { requestId: c.get('requestId') },
  });
});

/** 给某条留言点赞 / 取消 */
playerRoutes.post('/:id/comments/:commentId/like', async (c) => {
  const actorId = requireUser(c);
  const env = c.env;
  const targetId = c.req.param('id');
  const commentId = c.req.param('commentId');

  const row = await env.DB.prepare(
    `SELECT id, target_user_id AS targetUserId, deleted_at AS deletedAt FROM comments WHERE id = ?`,
  )
    .bind(commentId)
    .first<{ id: string; targetUserId: string; deletedAt: number | null }>();

  if (!row || row.targetUserId !== targetId) {
    throw new ApiError('NOT_FOUND', '留言不存在');
  }
  if (row.deletedAt !== null) {
    throw new ApiError('CONFLICT', '这条留言已被删除');
  }

  const existing = await env.DB.prepare(
    `SELECT id FROM comment_likes WHERE comment_id = ? AND user_id = ?`,
  )
    .bind(commentId, actorId)
    .first<{ id: string }>();

  if (existing) {
    await env.DB.prepare(`DELETE FROM comment_likes WHERE id = ?`).bind(existing.id).run();
  } else {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO comment_likes (id, comment_id, user_id, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(newId(now), commentId, actorId, now)
      .run();
  }

  const count = await env.DB.prepare(
    `SELECT count(*) AS n FROM comment_likes WHERE comment_id = ?`,
  )
    .bind(commentId)
    .first<{ n: number }>();

  return c.json({
    data: { commentId, likeCount: count?.n ?? 0, likedByMe: !existing },
    meta: { requestId: c.get('requestId') },
  });
});
