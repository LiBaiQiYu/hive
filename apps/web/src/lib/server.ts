/**
 * 赛事服务器：国服 / 全球服。
 *
 * 只影响"在哪打"，不参与任何计分——段位、评分、分队规则两边完全一致。
 * 差别只在客户端：
 *   · 国服：蒸汽平台启动，或在 Steam 里给 Dota2 加启动项 `-perfectworld`
 *   · 全球服：Steam 直接启动，不加任何启动项
 * 两个服是独立匹配池，进错服会和队友碰不上。这段说明只在这里写一次，
 * 赛事卡、赛事详情、后台表单共用同一份文案，避免三处各说各话。
 */

export type ServerRegion = 'CN' | 'GLOBAL';

export const SERVER_LABEL: Record<ServerRegion, string> = {
  CN: '国服',
  GLOBAL: '全球服',
};

/** 下拉选项：全球服在前（= 什么都不做的默认行为） */
export const SERVER_OPTIONS: Array<{ label: string; value: ServerRegion }> = [
  { label: '全球服（Steam 直接启动）', value: 'GLOBAL' },
  { label: '国服（蒸汽平台 / -perfectworld）', value: 'CN' },
];

/** 老数据或没传时按全球服处理 */
export function serverLabel(region: string | null | undefined): string {
  return region === 'CN' ? SERVER_LABEL.CN : SERVER_LABEL.GLOBAL;
}

/** 圆圈问号里的说明（HelpTip 的 props，直接 v-bind 用） */
export const SERVER_HELP = {
  title: '国服 / 全球服怎么进？',
  steps: [
    '① 国服：用「蒸汽平台」启动 Dota2，或在 Steam 里给 Dota2 加启动项 -perfectworld',
    '② 全球服：直接 Steam 启动，不加任何启动项',
    '③ 两个服是独立的匹配池，进错服会和队友碰不上，房间也连不上',
  ],
  note: '标签说的是这一场在哪打。段位、评分、分队规则两个服通用，不分开算。',
};
