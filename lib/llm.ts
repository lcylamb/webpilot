import OpenAI from "openai";

/**
 * 统一走 OpenAI 兼容接口，DeepSeek / Qwen 都支持。
 * 通过环境变量切换：
 *   LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 *
 * 客户端懒初始化：不能在模块顶层 new OpenAI —— Next build 的
 * 「收集页面数据」阶段会执行路由模块的顶层代码，那时容器里没有
 * API key 会直接把构建炸掉（本地能过只是因为 .env.local 在场）。
 * 密钥属于运行时配置，应该等到第一次真正发请求时才检查。
 */
let _llm: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_llm) {
    if (!process.env.LLM_API_KEY) {
      throw new Error("缺少 LLM_API_KEY 环境变量（复制 .env.example 为 .env.local 并填入）");
    }
    _llm = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || "https://api.deepseek.com",
    });
  }
  return _llm;
}

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
  return getClient().chat.completions.create(
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
