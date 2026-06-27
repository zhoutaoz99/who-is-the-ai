/**
 * 宽松 JSON 解析(M0.3):裁判/优化器要求"只输出 JSON",但模型偶尔会带 markdown 围栏、
 * 解释文字或多余逗号。本工具统一处理:剥围栏 → 直接 parse → 退化为抠第一个 {...}。
 * 全部失败返回 null,由调用方决定重试或标 partial。
 */
export function parseJsonObject<T = unknown>(raw: string): T | null {
  if (!raw) return null;

  let text = raw.trim();
  // 剥 ```json / ``` 围栏。
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // 直接 parse。
  const direct = tryParse(text);
  if (direct !== undefined) return direct as T;

  // 退化为抠第一个 {...} 段。
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const fallback = tryParse(match[0]);
  return fallback !== undefined ? (fallback as T) : null;
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
