/**
 * HIVE · PBKDF2 CPU 校准 Worker（临时，测完请删除）
 *
 * 目的：在真实的 Workers 免费版上测出「一次 PBKDF2-SHA256 哈希消耗多少 CPU」，
 *      用来决定 PASSWORD_PBKDF2_ITERATIONS 的最终值。
 *      目标：单次哈希 ≤6ms，给会话校验、D1 查询、响应序列化留 4ms 余量。
 *
 * 注意：
 *   · 本地 `wrangler dev` 不执行 CPU 限额，本地测出的数字没有参考价值。
 *   · 免费版每请求 10ms CPU，超限直接返回 1102 —— 那也是有效结论。
 *   · 本接口无鉴权，等于一个 CPU 燃烧器，测试结束务必删除。
 */

const PEPPER = 'smoke-only-pepper-do-not-reuse';
const PASSWORD = 'correct horse battery staple';

function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== '/') {
      return new Response('use /?iterations=25000&rounds=5', { status: 404 });
    }

    const iterations = clampInt(url.searchParams.get('iterations'), 25000, 1000, 500000);
    const rounds = clampInt(url.searchParams.get('rounds'), 5, 1, 20);

    // 复刻生产实现：先 HMAC-SHA256(pepper, password)，再对该结果做 PBKDF2。
    // pepper 这一步的 CPU 也要计入成本，不能只测 PBKDF2。
    const enc = new TextEncoder();
    const t0 = performance.now();
    const pepperKey = await crypto.subtle.importKey(
      'raw', enc.encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const peppered = await crypto.subtle.sign('HMAC', pepperKey, enc.encode(PASSWORD));
    const pepperMs = performance.now() - t0;

    const baseKey = await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']);

    const samples = [];
    for (let i = 0; i < rounds; i += 1) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const start = performance.now();
      await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey,
        256,
      );
      samples.push(performance.now() - start);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const min = sorted[0];
    const median = sorted[Math.floor(sorted.length / 2)];
    const max = sorted[sorted.length - 1];

    // 这是"墙钟时间"，包含事件循环调度开销，是 CPU 的乐观上界；
    // 权威数字请看 Dashboard 的 CPU Time 指标。
    const verdict =
      median <= 6 ? 'OK: 在 6ms 预算内'
        : median <= 8 ? 'TIGHT: 余量不足 4ms，建议下调迭代次数'
          : 'RISKY: 已逼近 10ms 上限，需要下调';

    return Response.json(
      {
        iterations,
        rounds,
        pepperMs: +pepperMs.toFixed(3),
        minMs: +min.toFixed(2),
        medianMs: +median.toFixed(2),
        maxMs: +max.toFixed(2),
        nsPerIteration: Math.round((min * 1e6) / iterations),
        verdict,
        samples: samples.map((s) => +s.toFixed(2)),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  },
};
