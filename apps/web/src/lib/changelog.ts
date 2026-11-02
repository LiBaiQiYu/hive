/**
 * 版本号与更新日志 —— 全站唯一出口。
 *
 * 发版流程（两步，别漏第二步）：
 *   1. 改 APP_VERSION：加功能提 minor，修问题提 patch
 *   2. 在 RELEASES 最前面插一条，写"这一版相对上一版"的改动
 *
 * 写条目的规矩：
 *   · 只写**玩家能感知**的事，不写内部实现、不写安全细节、不写还没上线的半成品
 *   · 一条一句话，动词开头，尽量不超过 20 字——弹窗里放不下长句
 *   · 版本号变了却没有对应条目 → 弹窗会是空的，发版前自己看一眼
 *
 * 弹窗行为：用户看过的版本号存在 localStorage（hive-seen-version）。
 * 和 APP_VERSION 对不上就自动弹一次，之后只能从页脚的版本号点开，
 * 免得每次刷新都糊一脸。
 */
export const APP_VERSION = '1.0.0';

export interface ReleaseNote {
  version: string;
  /** 发版日期，YYYY-MM-DD，纯展示用 */
  date: string;
  items: string[];
}

export const RELEASES: ReleaseNote[] = [
  {
    version: '1.0.0',
    date: '2026-11-02',
    items: [
      '首个公开版本，邀请制注册，仅限群成员',
      '绑定 Steam 验证归属，也可用数字 ID 拉取段位',
      'WARROOM 评分公开可解释：段位与社区出勤两项构成',
      '赛事报名、系统自动分队，管理员可拖拽微调阵容',
      '赛后录入胜负，个人战绩与全站排行榜自动更新',
      '我的主页：评分构成、游戏身份、卡片外观、位置偏好',
      '玩家卡支持材质与边框外观，深浅色主题分别调校',
      '管理后台：赛事、邀请码、评分、成员、队列与审计',
      '正式域名 hive.cwa1e.top 上线',
    ],
  },
];

/** 当前版本对应的条目；找不到时返回 null，前端要能优雅退化 */
export function currentRelease(): ReleaseNote | null {
  return RELEASES.find((release) => release.version === APP_VERSION) ?? null;
}
