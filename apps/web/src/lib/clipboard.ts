/**
 * 复制文本：优先 Clipboard API，失败退回 textarea + execCommand。
 *
 * 为什么需要兜底：Clipboard API 只在安全上下文（https / localhost）可用，
 * 用局域网 IP 打开本站时它直接不存在；只写 navigator.clipboard 的按钮
 * 在那台机器上就是一个永远没反应的按钮。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 继续走兜底 */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // 放在视口外，避免复制瞬间页面跳动
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
