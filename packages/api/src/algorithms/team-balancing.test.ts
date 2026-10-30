import { describe, expect, it } from 'vitest';
import {
  balanceTeams,
  computePositionFit,
  CONFLICT_THRESHOLD,
  type BalancePlayer,
  type PositionPreference,
} from './team-balancing';

/** 所有人都只有一个志愿位置、熟练度 50（修正为 0） */
function onlyPosition(position: number): PositionPreference[] {
  return [{ position, rank: 1, proficiency: 50 }];
}

function player(id: string, rating: number, positions: PositionPreference[]): BalancePlayer {
  return { userId: id, rating, positions };
}

/** 造 10 个人，位置按 1..5 循环铺满 */
function roster(ratings: number[]): BalancePlayer[] {
  return ratings.map((rating, index) => player(`u${index}`, rating, onlyPosition((index % 5) + 1)));
}

const sortedPositions = (members: { position: number }[]): number[] =>
  members.map((m) => m.position).sort((a, b) => a - b);

describe('computePositionFit', () => {
  const preferences: PositionPreference[] = [
    { position: 2, rank: 1, proficiency: 80 },
    { position: 3, rank: 2, proficiency: 60 },
    { position: 4, rank: 3, proficiency: 20 },
  ];

  it('第一志愿 = 100 基准 + 熟练度修正', () => {
    // 100 + (80-50)/2 = 115 → 裁到 100
    expect(computePositionFit(preferences, 2)).toBe(100);
  });

  it('第二志愿每降一档扣 20', () => {
    // 80 + (60-50)/2 = 85
    expect(computePositionFit(preferences, 3)).toBe(85);
  });

  it('熟练度低会往下拉', () => {
    // 60 + (20-50)/2 = 45
    expect(computePositionFit(preferences, 4)).toBe(45);
  });

  it('没填报的位置给 10 分，不是 0', () => {
    expect(computePositionFit(preferences, 5)).toBe(10);
    expect(computePositionFit([], 1)).toBe(10);
  });

  it('结果永远落在 0..100', () => {
    const extremes: PositionPreference[] = [{ position: 1, rank: 1, proficiency: 100 }];
    expect(computePositionFit(extremes, 1)).toBeLessThanOrEqual(100);
    const terrible: PositionPreference[] = [{ position: 1, rank: 5, proficiency: 0 }];
    expect(computePositionFit(terrible, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe('balanceTeams', () => {
  it('只接受恰好 10 人', () => {
    expect(() => balanceTeams(roster([700, 700, 700, 700, 700, 700, 700, 700, 700]))).toThrow(
      /REQUIRES_10_PLAYERS/,
    );
  });

  it('拒绝重复的 userId', () => {
    const duplicate = Array.from({ length: 10 }, (_, i) => player('same', 700, onlyPosition(1)));
    expect(() => balanceTeams(duplicate)).toThrow(/DUPLICATE_USER/);
  });

  it('枚举 126 种分队方案（固定一人消除镜像）', () => {
    const result = balanceTeams(roster([700, 710, 720, 730, 740, 750, 760, 770, 780, 790]));
    expect(result.candidatesEvaluated).toBe(126);
  });

  it('镜像配对的评分能分出 gap = 0 的两队', () => {
    const result = balanceTeams(roster([900, 850, 800, 750, 700, 700, 750, 800, 850, 900]));
    expect(result.ratingGap).toBe(0);
    expect(result.teams[0].totalRating).toBe(result.teams[1].totalRating);
  });

  it('极端断层时给出理论最优（5000 对 0 只能做到 1000 的差）', () => {
    const result = balanceTeams(roster([1000, 1000, 1000, 1000, 1000, 0, 0, 0, 0, 0]));
    // 每队 5 人，只能 2 强 3 弱 vs 3 强 2 弱 → 2000 : 3000
    expect(result.ratingGap).toBe(1000);
  });

  it('评分相同时由位置契合度决定分队', () => {
    // 5 个只会打 1 号位、5 个只会打 2 号位，评分完全相同
    const players: BalancePlayer[] = [
      ...Array.from({ length: 5 }, (_, i) => player(`carry${i}`, 700, onlyPosition(1))),
      ...Array.from({ length: 5 }, (_, i) => player(`mid${i}`, 700, onlyPosition(2))),
    ];
    const result = balanceTeams(players);

    expect(result.ratingGap).toBe(0);
    for (const team of result.teams) {
      const positions = team.members.map((m) => m.position).sort();
      expect(positions).toEqual([1, 2, 3, 4, 5]);

      // 关键结论不是"3+2 正好"，而是"不会出现 5 个同位置挤一队"：
      // 全覆盖队（1 carry + 1 mid + 3 个补位）得 230 分，纯 carry 队只有 140 分，
      // 代价函数会把后者淘汰。至于 4+1 还是 3+2，在这个退化输入下完全等价
      // （补位都是 10 分），属于合理并列，不应该由算法强行区分。
      const carries = team.members.filter((m) => m.userId.startsWith('carry')).length;
      expect(carries).toBeGreaterThanOrEqual(1);
      expect(carries).toBeLessThanOrEqual(4);

      // 本命位置必须站对：1 号位是 carry（满分 100），2 号位是 mid（满分 100）
      const pos1 = team.members.find((m) => m.position === 1);
      const pos2 = team.members.find((m) => m.position === 2);
      expect(pos1?.userId.startsWith('carry')).toBe(true);
      expect(pos1?.fitScore).toBe(100);
      expect(pos2?.userId.startsWith('mid')).toBe(true);
      expect(pos2?.fitScore).toBe(100);
    }
  });

  it('每队 5 人、位置恰好覆盖 1..5、总分与平均分自洽', () => {
    const result = balanceTeams(roster([640, 720, 810, 500, 690, 770, 580, 830, 660, 700]));
    for (const team of result.teams) {
      expect(team.members).toHaveLength(5);
      expect(sortedPositions(team.members)).toEqual([1, 2, 3, 4, 5]);
      expect(team.totalRating).toBe(team.members.reduce((sum, m) => sum + m.rating, 0));
      expect(team.averageRating).toBe(Math.round(team.totalRating / 5));
    }
    expect(result.teams[0].side).toBe('RADIANT');
    expect(result.teams[1].side).toBe('DIRE');
  });

  it('相同输入 + 相同种子 → 完全相同的结果（可复盘）', () => {
    const players = roster([640, 720, 810, 500, 690, 770, 580, 830, 660, 700]);
    const a = balanceTeams(players, { seed: 7 });
    const b = balanceTeams(players, { seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('种子 0 取最优解，其他种子只在候选池里挑，代价不会超出预算', () => {
    const players = roster([640, 720, 810, 500, 690, 770, 580, 830, 660, 700]);
    const best = balanceTeams(players, { seed: 0 });

    for (const seed of [1, 2, 3, 99, 12345]) {
      const other = balanceTeams(players, { seed });
      // 多样性预算约束的是综合代价，不是分差：
      // 允许"分差略大但位置更顺"的阵容，这正是运营换种子时想要的
      expect(other.cost).toBeLessThanOrEqual(best.cost + 40);
      expect(other.teams[0].members).toHaveLength(5);
    }
  });

  it('位置冲突会变成 warnings，而不是抛错', () => {
    // 6 个人只会 1 号位：无论怎么分都有人打不上本命位置
    const players: BalancePlayer[] = [
      ...Array.from({ length: 6 }, (_, i) => player(`mid${i}`, 700, onlyPosition(1))),
      ...Array.from({ length: 4 }, (_, i) => player(`sup${i}`, 700, onlyPosition(5))),
    ];
    const result = balanceTeams(players);

    expect(result.teams[0].members).toHaveLength(5);
    expect(result.warnings.some((w) => w.type === 'POSITION_CONFLICT')).toBe(true);

    const conflicts = result.warnings.filter((w) => w.type === 'POSITION_CONFLICT');
    for (const conflict of conflicts) {
      if (conflict.type === 'POSITION_CONFLICT') {
        expect(conflict.fitScore).toBeLessThan(CONFLICT_THRESHOLD);
      }
    }
  });

  it('评分越界会被夹到 0..1000', () => {
    const players = roster([5000, 5000, 5000, 5000, 5000, -100, -100, -100, -100, -100]);
    const result = balanceTeams(players);
    const all = [...result.teams[0].members, ...result.teams[1].members];
    for (const member of all) {
      expect(member.rating).toBeGreaterThanOrEqual(0);
      expect(member.rating).toBeLessThanOrEqual(1000);
    }
  });
});
