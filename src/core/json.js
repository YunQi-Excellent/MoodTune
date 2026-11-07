/**
 * 从模型输出里提取第一个 JSON 对象。
 * 兼容 ```json 代码块、前后解释文字；解析失败返回 null。
 * @param {unknown} text
 * @returns {object|null}
 */
export function extractJson(text) {
  let value = String(text ?? '').trim();

  const fence = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) value = fence[1].trim();

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
