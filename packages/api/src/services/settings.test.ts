/**
 * 运行期设置的纯函数守卫。
 *
 * 重点锁两件事：
 *   1. 数据库键名与迁移 0018 的播种值一致——改了键，老库里的行就读不到，
 *      表现成"后台改了、注册页没变"；
 *   2. 兜底默认值是**开放注册**（本次产品决定），别在重构时手滑改成邀请制。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTING_KEYS, parseSettingBool } from './settings';

describe('parseSettingBool', () => {
  it('认识 1/0 与 true/false', () => {
    expect(parseSettingBool('1', false)).toBe(true);
    expect(parseSettingBool('true', false)).toBe(true);
    expect(parseSettingBool('0', true)).toBe(false);
    expect(parseSettingBool('false', true)).toBe(false);
  });

  it('脏值 / 缺失一律回落默认值，而不是猜', () => {
    expect(parseSettingBool(undefined, true)).toBe(true);
    expect(parseSettingBool(null, false)).toBe(false);
    expect(parseSettingBool('yes', true)).toBe(true);
    expect(parseSettingBool('', false)).toBe(false);
  });
});

describe('设置键与默认值', () => {
  it('注册方式的键与迁移 0018 播种的键一致', () => {
    expect(SETTING_KEYS.registrationRequireInvite).toBe('registration.require_invite');
  });

  it('默认是开放注册（邀请码开关关闭）', () => {
    expect(DEFAULT_SETTINGS.registrationRequireInvite).toBe(false);
  });
});
