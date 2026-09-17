/**
 * 把"源站内容已删除/不可见"从"我们抓取失败"里区分出来。
 *
 * 这两类在日志里长得很像，但处置完全不同：内容没了改代码也救不回来，而抓取
 * 失败值得排查。之前就因为分不开，一条被作者删掉的抖音图文被当成解析逻辑的
 * bug 查了很久。
 */

/** 错误消息里带上这个前缀，表示源站已明确表示内容不存在。 */
export const REMOVED_ERROR_PREFIX = '源内容已不可用';

/** 三个平台页面/接口上表示内容不存在或不可见的说法。 */
const REMOVED_TEXT_PATTERNS = [
  // 抖音：图文/视频被删或下架时的整页提示
  /你要观看的(?:图文|视频|内容)不存在/,
  /该(?:作品|视频|内容)已(?:被)?(?:删除|下架)/,
  /作品不存在/,
  /视频不存在/,
  // 小红书
  /(?:笔记|内容)不存在/,
  /当前笔记(?:已删除|状态异常|无法查看)/,
  /该内容(?:已被删除|已失效)/,
  // B站
  /稿件不可见/,
  /稿件不存在/,
  /视频(?:已被删除|已失效|不见了)/,
  /啥都木有/,
  // 通用
  /内容(?:已)?(?:被)?删除/,
  /已被作者删除/,
];

/**
 * B站接口的业务码。这些码是源站给出的明确结论，比文案匹配可靠。
 * 参考 bilibili-API-collect 的公共错误码表。
 */
const BILIBILI_REMOVED_CODES = new Set([
  -404,   // 啥都木有
  62002,  // 稿件不可见
  62004,  // 稿件审核中
  62012,  // 仅 UP 主自己可见
]);

/** 小红书详情接口在笔记不存在时的业务码。 */
const XHS_REMOVED_CODES = new Set([-510001, 4041, -510000]);

/** 页面文案或接口 message 是否表示内容已不可用。 */
export function looksRemoved(text) {
  const value = String(text ?? '');
  if (!value) return false;
  return REMOVED_TEXT_PATTERNS.some((pattern) => pattern.test(value));
}

export function isBilibiliRemovedCode(code) {
  const number = Number(code);
  return Number.isFinite(number) && BILIBILI_REMOVED_CODES.has(number);
}

export function isXhsRemovedCode(code) {
  const number = Number(code);
  return Number.isFinite(number) && XHS_REMOVED_CODES.has(number);
}

/** 构造带标记的错误消息，供上层识别与日志区分。 */
export function removedError(platform, detail = '') {
  const suffix = String(detail || '').trim();
  return `${REMOVED_ERROR_PREFIX}（${platform}）${suffix ? `：${suffix}` : ''}`;
}

/** 一个错误（或消息）是否属于"源内容已不可用"。 */
export function isRemovedError(error) {
  const message = typeof error === 'string' ? error : String(error?.message ?? '');
  return message.includes(REMOVED_ERROR_PREFIX) || looksRemoved(message);
}
