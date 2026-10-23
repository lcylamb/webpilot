import OpenAI from "openai";

/**
 * 统一走 OpenAI 兼容接口，DeepSeek / Qwen 都支持。
 * 通过环境变量切换：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 */
export const llm = new OpenAI({
  apiKey: process.env.LLM_API_KEY,
  baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com",
});

export const LLM_MODEL = process.env.LLM_MODEL || "deepseek-chat";

const LLM_TIMEOUT_MS = Number(process.env.STEP_TIMEOUT_MS || 45000);

/** 工具定义（OpenAI function-calling 格式） */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 发起一次带工具定义的对话补全请求 */
export async function chat(messages: unknown[], tools: ToolSchema[]) {
  return llm.chat.completions.create(
    {
      model: LLM_MODEL,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools,
      tool_choice: "auto",
      temperature: 0,
    },
    // timeout 是 SDK 的 RequestOptions，属于第二个参数 —— 之前写进了 body 里，
    // 类型上是错的（会让 next build 的类型检查直接失败），运行时也会被忽略，
    // 等于单步超时根本没生效。
    { timeout: LLM_TIMEOUT_MS },
  );
}
