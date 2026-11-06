/**
 * 用户提交的短文本清洗（2026-11-06）。
 *
 * 起因：积分流水里出现过「外部应用「�ⲿ����E2E����」」这类乱码 —— 客户端送的字节
 * 不是合法 UTF-8（Windows 终端里用 curl 发中文就会这样），`TextDecoder` 会把它
 * 解成一串 U+FFFD 替换字符，**而我们当时把结果原样落库了**。替换字符一旦入库就
 * 再也还原不出原文，只能在写入这一层拦住。
 *
 * 清洗内容：
 *   · U+FFFD（解码失败的替换字符）—— 直接删掉，不是原文的一部分
 *   · 零宽字符与 BOM —— 肉眼看不见，但会让两段看起来相同的文字比较不相等
 *   · C0/C1 控制字符 —— 会破坏前端排版（短文本不需要换行）
 *   · 连续空白压成一个空格，首尾去空白
 *   · 按**码点**截断（不是 UTF-16 code unit）—— 否则会把 emoji 切成半个代理对，
 *     落库后又是一串乱码
 */
export function sanitizeUserText(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") return ""
  const cleaned = raw
    .replace(/\uFFFD/g, "")
    .replace(/[\u200B-\u200F\uFEFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (maxLength <= 0) return ""
  if (cleaned.length <= maxLength) return cleaned
  // Array.from 按码点拆分，emoji / 生僻字不会被切坏
  return Array.from(cleaned).slice(0, maxLength).join("")
}
