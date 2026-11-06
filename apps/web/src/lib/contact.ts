/**
 * 对外联系方式。
 *
 * 密码找回走 Email Routing 的收信地址（免费版不能主动发信，只能收到信后 reply），
 * 地址本身是部署配置的一部分：换域名时要同步改这里，并在 Cloudflare 控制台
 * 把 Email Routing 的自定义地址指到同一个 Worker。
 */
export const PASSWORD_RESET_EMAIL = 'reset@cwa1e.top';
