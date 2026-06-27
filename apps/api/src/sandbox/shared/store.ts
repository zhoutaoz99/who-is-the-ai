/**
 * 文件落盘(M0.4):沙盒产物(MatchRecord / ScoreRecord / PromptVersion / GenerationEval)
 * 统一以 JSON/JSONL 存到 sandbox-out 下分目录;MVP 不引 DB(Postgres/Redis 留给在线层)。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 把任意对象以美观 JSON 写到 dir/filename,目录不存在则创建;返回完整路径。 */
export async function writeJsonFile(
  dir: string,
  filename: string,
  data: unknown,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, filename);
  await writeFile(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}
