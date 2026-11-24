import { api } from './api';

/**
 * 密码找回的三种部署形态（由服务端 `GET /api/config` 告知）：
 *   · `self`    ：配了 SMTP，填邮箱由系统发信（自建部署）；
 *   · `inbound` ：玩家发信到 reset@，系统回信（Cloudflare 免费版）；
 *   · `admin`   ：只能找管理员重置。
 */
export type ResetFlow = 'self' | 'inbound' | 'admin';

/**
 * 登录前就能拿到的公开配置（`GET /api/config`）。
 */
export interface PublicConfig {
  /** true = 注册必须填邀请码；false = 开放注册 */
  registrationRequireInvite: boolean;
  /** 密码找回走哪条路 */
  passwordResetFlow: ResetFlow;
}

/**
 * 取不到配置时按「需要邀请码 + 只能找管理员」处理（fail-closed）：
 * 宁可让人去群里问一句，也不要因为一次网络抖动把注册页显示成开放、
 * 提交后却被服务端拒绝——那种失败最难解释。
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  try {
    const config = await api<PublicConfig>('/config');
    const flow = config?.passwordResetFlow;
    return {
      registrationRequireInvite: config?.registrationRequireInvite !== false,
      passwordResetFlow: flow === 'self' || flow === 'inbound' ? flow : 'admin',
    };
  } catch {
    return { registrationRequireInvite: true, passwordResetFlow: 'admin' };
  }
}
