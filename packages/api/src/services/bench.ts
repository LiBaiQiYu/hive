/**
 * 「没进阵容的人」——报名了却没出现在这套阵容里，以及为什么。
 *
 * 四种原因，数据来源不同：
 *   · WAITLIST     报名状态就是候补（人数超出容量或封盘切场），带候补顺位
 *   · ABSENT       换人时勾了「本人没来」：那场记弃赛，阵容里已经被顶掉
 *   · SUBSTITUTED  临场调整被换下（MANUAL），不算弃赛
 *   · WITHDRAWN    截止前自己退赛
 *
 * 这里只做纯数据整理、不碰数据库，方便单测。排序：本场换人（按位置）
 * → 候补（按顺位）→ 退赛；同一个人只出现一次（换人优先，因为它更"具体"）。
 *
 * 注意：**只收本场被换下的**，不是"赛事里所有没上场的人"。
 * 一个赛事开两场时，另一场的 10 个人也不在这套阵容里，但他们不是在"候补"。
 */

export type BenchReason = 'WAITLIST' | 'ABSENT' | 'SUBSTITUTED' | 'WITHDRAWN';

export interface BenchRow {
  userId: string | null;
  displayName: string;
  /** 报名/换人时占的位置，没有就是 null */
  position: number | null;
  reason: BenchReason;
  /** 候补顺位（1 起）；其他原因为 null */
  rank: number | null;
  /** 一句人话说明：谁顶了他 / 什么时候退的 */
  detail: string | null;
}

/** match_substitutions 里"被换下"的那一侧 */
export interface SubstitutionOutRow {
  outUserId: string | null;
  outName: string | null;
  inName: string | null;
  position: number | null;
  /** ABSENT = 本人没来（弃赛）；MANUAL = 临场调整 */
  reason: string;
  createdAt: number;
}

/** registrations 里没进阵容的行 */
export interface BenchRegistrationRow {
  userId: string;
  displayName: string | null;
  status: string;
  position: number | null;
  waitlistPosition: number | null;
  /** 报名时的评分快照，用来在同顺位时给前端做参考（可为空） */
  rating: number | null;
}

export interface BuildBenchInput {
  substitutions: readonly SubstitutionOutRow[];
  registrations: readonly BenchRegistrationRow[];
  /** 当前阵容里所有"有账号"的人（含临时参赛者以外的正选与替补） */
  lineupUserIds: ReadonlySet<string>;
}

export function buildBench(input: BuildBenchInput): BenchRow[] {
  const { substitutions, registrations, lineupUserIds } = input;
  const rows: BenchRow[] = [];
  const seen = new Set<string>();

  const substituted = substitutions
    .filter((row) => row.outUserId !== null && !lineupUserIds.has(row.outUserId))
    .sort((a, b) => (a.position ?? 99) - (b.position ?? 99) || a.createdAt - b.createdAt);

  for (const row of substituted) {
    const userId = row.outUserId as string;
    if (seen.has(userId)) continue;
    seen.add(userId);

    const absent = row.reason === 'ABSENT';
    const replacedBy = row.inName ? `，由「${row.inName}」顶替` : '';
    rows.push({
      userId,
      displayName: row.outName ?? '（未知玩家）',
      position: row.position,
      reason: absent ? 'ABSENT' : 'SUBSTITUTED',
      rank: null,
      detail: absent ? `报名后未到场${replacedBy}` : `临场调整被换下${replacedBy}`,
    });
  }

  const candidates = registrations.filter(
    (row) => !lineupUserIds.has(row.userId) && !seen.has(row.userId),
  );

  const waitlisted = candidates
    .filter((row) => row.status === 'WAITLIST')
    .sort(
      (a, b) =>
        (a.waitlistPosition ?? 999) - (b.waitlistPosition ?? 999) ||
        (b.rating ?? 0) - (a.rating ?? 0),
    );

  for (const row of waitlisted) {
    seen.add(row.userId);
    rows.push({
      userId: row.userId,
      displayName: row.displayName ?? '（未知玩家）',
      position: row.position,
      reason: 'WAITLIST',
      rank: row.waitlistPosition ?? null,
      detail:
        row.waitlistPosition !== null
          ? `候补第 ${row.waitlistPosition} 位`
          : '候补（顺位待重排）',
    });
  }

  const withdrawn = candidates
    .filter((row) => row.status === 'WITHDRAWN')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? '', 'zh'));

  for (const row of withdrawn) {
    seen.add(row.userId);
    rows.push({
      userId: row.userId,
      displayName: row.displayName ?? '（未知玩家）',
      position: row.position,
      reason: 'WITHDRAWN',
      rank: null,
      detail: '截止前退赛',
    });
  }

  return rows;
}
