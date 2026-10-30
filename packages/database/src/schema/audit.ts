/** 管理员操作流水：业务表只存当前状态，历史一律查 audit_logs。 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { TS_NOW } from './_shared';
import { users } from './users';

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorRole: text('actor_role', { enum: ['PLAYER', 'ADMIN', 'SYSTEM'] }),
    /** 形如 rating.adjust / event.publish / lineup.update */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    beforeJson: text('before_json'),
    afterJson: text('after_json'),
    reason: text('reason'),
    requestId: text('request_id'),
    ipHash: text('ip_hash'),
    createdAt: integer('created_at').notNull().default(TS_NOW),
  },
  (t) => [
    index('idx_audit_logs_entity').on(t.entityType, t.entityId, t.createdAt),
    index('idx_audit_logs_actor').on(t.actorId, t.createdAt),
    index('idx_audit_logs_created').on(t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
