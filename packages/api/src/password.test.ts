import { describe, expect, it } from 'vitest';
import { newId } from '@hive/shared';
import { hashPassword, verifyPassword } from './password';

const PEPPER = 'test-pepper';
// 测试里用低迭代，避免 CI 变慢；生产值由 env 决定
const ITER = 1000;

describe('password', () => {
  it('哈希后能验证通过', async () => {
    const stored = await hashPassword('correct horse battery staple', PEPPER, ITER);
    expect(stored.startsWith('pbkdf2_sha256$p1$1000$')).toBe(true);
    await expect(verifyPassword(stored, 'correct horse battery staple', PEPPER, ITER)).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
  });

  it('密码错误时不通过', async () => {
    const stored = await hashPassword('correct horse battery staple', PEPPER, ITER);
    const result = await verifyPassword(stored, 'wrong password', PEPPER, ITER);
    expect(result.ok).toBe(false);
  });

  it('pepper 不同时不通过（换 pepper 等于全体密码失效）', async () => {
    const stored = await hashPassword('same-password', PEPPER, ITER);
    const result = await verifyPassword(stored, 'same-password', 'another-pepper', ITER);
    expect(result.ok).toBe(false);
  });

  it('迭代次数落后时标记 needsRehash', async () => {
    const stored = await hashPassword('upgrade-me', PEPPER, ITER);
    const result = await verifyPassword(stored, 'upgrade-me', PEPPER, ITER * 2);
    expect(result).toEqual({ ok: true, needsRehash: true });
  });

  it('两次哈希同一密码得到不同结果（有盐）', async () => {
    const a = await hashPassword('same-password', PEPPER, ITER);
    const b = await hashPassword('same-password', PEPPER, ITER);
    expect(a).not.toBe(b);
  });

  it('拒绝格式错误的哈希串', async () => {
    expect((await verifyPassword('not-a-hash', 'x', PEPPER, ITER)).ok).toBe(false);
    expect((await verifyPassword('pbkdf2_sha256$p1$abc$AA$BB', 'x', PEPPER, ITER)).ok).toBe(false);
  });
});

describe('newId', () => {
  it('符合 UUIDv7 形状', () => {
    const id = newId(1761822000000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('时间序单调：后生成的一定不小于先生成的', () => {
    const ids = [newId(1000), newId(1001), newId(1002)];
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('同一毫秒内不重复', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId(1761822000000)));
    expect(ids.size).toBe(500);
  });
});
