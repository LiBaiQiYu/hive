import { api } from './api';

/**
 * 登录前就能拿到的公开配置（`GET /api/config`）。
 * 目前只有一件事：注册要不要邀请码。
 */
export interface PublicConfig {
  /** true = 注册必须填邀请码；false = 开放注册 */
  registrationRequireInvite: boolean;
}

/**
 * 取不到配置时按「需要邀请码」处理（fail-closed）：
 * 宁可让人去群里问一句，也不要因为一次网络抖动把注册页显示成开放、
 * 提交后却被服务端拒绝——那种失败最难解释。
 */
export async function fetchPublicConfig(): Promise<PublicConfig> {
  try {
    const config = await api<PublicConfig>('/config');
    return { registrationRequireInvite: config?.registrationRequireInvite !== false };
  } catch {
    return { registrationRequireInvite: true };
  }
}
