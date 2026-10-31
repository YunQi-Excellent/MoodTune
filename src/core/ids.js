/**
 * 生成带前缀的业务 ID。
 * 允许注入时间与随机源，方便测试得到稳定结果。
 * @param {string} [prefix]
 * @param {number} [now]
 * @param {() => number} [random]
 * @returns {string}
 */
export function createId(prefix = 'id', now = Date.now(), random = Math.random) {
  const time = Number(now).toString(36);
  const suffix = Number(random()).toString(36).slice(2, 8);
  return `${prefix}-${time}-${suffix}`;
}
