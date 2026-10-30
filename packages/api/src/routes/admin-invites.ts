import { Hono } from 'hono';
import { z } from 'zod';
import { ApiError, newId } from '@hive/shared';
import type { AppEnv } from '../env';
import { requireAdmin } from '../guard';

export const adminInviteRoutes = new Hono<AppEnv>();

/**
 * Crockford Base32：去掉 I / L / O / U。
 * 目的是让人手抄到 QQ 里时不会把 1 和 I、0 和 O 搞混。
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function generateCode(): string {
  // 256 % 32 === 0，直接取模不存在偏置
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return `HIVE-${raw.slice(0, 4)}-${raw.slice(4)}`;
}

const createSchema = z.object({
  label: z.string().trim().max(40).optional(),
  /** 0 表示不限次数；默认 1（一码一人） */
  maxUses: z.number().int().min(0).max(1000).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

const isoToMs = (value: string | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

interface InviteRow {
  id: string;
  code: string;
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
adminInviteRoutes.get('/', async (c) => {
  requireAdmin(c);

  const rows = await c.env.DB.prepare(
    `SELECT id, code, label, max_uses AS maxUses, used_count AS usedCount,
            expires_at AS expiresAt, revoked_at AS revokedAt, created_at AS createdAt
       FROM invite_codes
      ORDER BY created_at DESC
      LIMIT 200`,
  ).all<InviteRow>();

  const list = rows.results ?? [];
  const now = Date.now();
  const summary = {
    total: list.length,
    available: list.filter(
      (row) =>
        row.revokedAt === null &&
        (row.expiresAt === null || row.expiresAt > now) &&
        (row.maxUses === 0 || row.usedCount < row.maxUses),
    ).length,
    used: list.reduce((sum, row) => sum + row.usedCount, 0),
  };

  return c.json({
    data: { codes: list, summary },
    meta: { requestId: c.get('requestId') },
  });
});

/* -------------------------------------------------------------------------- */
adminInviteRoutes.post('/', async (c) => {
  const adminId = requireAdmin(c);
  const parsed = createSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    throw new ApiError('VALIDATION_FAILED', '输入不合法', parsed.error.flatten().fieldErrors);
  }

  const now = Date.now();
  const maxUses = parsed.data.maxUses ?? 1;
  const expiresAt = isoToMs(parsed.data.expiresAt);
  if (expiresAt !== null && expiresAt <= now) {
    throw new ApiError('VALIDATION_FAILED', '过期时间必须晚于当前时间');
  }

  // 唯一约束冲突就换一个码重试，最多 3 次
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = newId(now);
    const code = generateCode();
    try {
      await c.env.DB.prepare(
        `INSERT INTO invite_codes (id, code, label, max_uses, used_count, expires_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
        .bind(id, code, parsed.data.label ?? null, maxUses, expiresAt, adminId, now, now)
        .run();

      await c.env.DB.prepare(
        `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
           after_json, request_id, created_at)
         VALUES (?, ?, 'ADMIN', 'invite.create', 'invite_code', ?, ?, ?, ?)`,
      )
        .bind(
          newId(now),
          adminId,
          id,
          JSON.stringify({ code, label: parsed.data.label ?? null, maxUses }),
          c.get('requestId') ?? null,
          now,
        )
        .run();

      return c.json(
        {
          data: { id, code, label: parsed.data.label ?? null, maxUses, expiresAt },
          meta: { requestId: c.get('requestId') },
        },
        201,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('UNIQUE')) throw err;
    }
  }

  throw new ApiError('INTERNAL', '生成邀请码失败，请重试');
});

/* -------------------------------------------------------------------------- */
adminInviteRoutes.post('/:id/revoke', async (c) => {
  const adminId = requireAdmin(c);
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT id, code, revoked_at AS revokedAt FROM invite_codes WHERE id = ?`,
  )
    .bind(c.req.param('id'))
    .first<{ id: string; code: string; revokedAt: number | null }>();
  if (!existing) throw new ApiError('NOT_FOUND', '邀请码不存在');

  // 重复撤销不再报错，直接返回当前状态——这个按钮一定会被点两次
  if (existing.revokedAt !== null) {
    return c.json({ data: { id: existing.id, revokedAt: existing.revokedAt } });
  }

  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE invite_codes SET revoked_at = ?, updated_at = ? WHERE id = ?`).bind(
      now,
      now,
      existing.id,
    ),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id,
         after_json, request_id, created_at)
       VALUES (?, ?, 'ADMIN', 'invite.revoke', 'invite_code', ?, ?, ?, ?)`,
    ).bind(
      newId(now),
      adminId,
      existing.id,
      JSON.stringify({ code: existing.code }),
      c.get('requestId') ?? null,
      now,
    ),
  ]);

  return c.json({ data: { id: existing.id, revokedAt: now } });
});
