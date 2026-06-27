import { readFileSync } from "fs";
import { join } from "path";

const cache = new Map<string, string>();

function readFile(filename: string): string {
  if (!cache.has(filename)) {
    cache.set(
      filename,
      readFileSync(join(__dirname, "prompts", filename), "utf-8"),
    );
  }
  return cache.get(filename)!;
}

/** Load a static prompt file (no variable substitution). */
export function loadPrompt(filename: string): string {
  return readFile(filename).trim();
}

/**
 * Render a template string with {{var}} placeholders and {{#if var}}...{{/if}}
 * conditionals. Pure — operates on an in-memory template, so it is shared by
 * both the file-based loader and the DB-backed PromptRegistry.
 */
export function renderTemplateString(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;

  // Process {{#if var}}...{{/if}} blocks
  result = result.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName: string, content: string) => {
      const value = vars[varName];
      if (value !== undefined && value !== "") {
        return content;
      }
      return "";
    },
  );

  // Replace {{var}} placeholders
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  // Collapse blank lines left by removed conditional blocks
  return result.replace(/\n{2,}/g, "\n").trim();
}

/** Render a template file with {{var}} placeholders and {{#if var}}...{{/if}} conditionals. */
export function renderTemplate(
  filename: string,
  vars: Record<string, string>,
): string {
  return renderTemplateString(readFile(filename), vars);
}

/** Read a prompt file's raw (untrimmed) content — used to seed the DB version store. */
export function readPromptFile(filename: string): string {
  return readFile(filename);
}

/**
 * 读取一个【提示词版本】的正文(编排器 PromptVersionStore 写到 sandbox-out/versions/<id>.prompt.txt)。
 * 命中返回 trim 后的文本;不存在返回 null(调用方回退到产品默认 ai-player 提示词)。
 * 仅 ai_under_test 用,使配对评测能比较不同版本的 AI 系统提示词。
 */
export function loadPromptVersionText(versionId: string): string | null {
  if (!versionId) return null;
  const dir = process.env.SANDBOX_OUT_DIR ?? join(process.cwd(), "sandbox-out");
  try {
    return readFileSync(join(dir, "versions", `${versionId}.prompt.txt`), "utf-8").trim();
  } catch {
    return null;
  }
}
