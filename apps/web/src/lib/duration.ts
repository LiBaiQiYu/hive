/**
 * 秒数 → 时长文本。
 *
 * 不足 1 小时用 m:ss（45:30），满 1 小时用 h:mm:ss（1:05:30）——
 * 比赛时长最长可到 4 小时，只显示分钟会变成 75:30 这种不好读的数。
 * 0 / null 视为"没有记录"。
 */
export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
