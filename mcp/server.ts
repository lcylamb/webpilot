/**
 * WebPilot MCP Server —— 把 9 个内置浏览器工具协议化。
 *
 * 为什么要做这个：
 * - 工具一旦走 MCP，任何 MCP 客户端（Claude Desktop、其他 Agent）都能复用
 *   这套「导航 → 快照 → 交互 → 断言」的浏览器能力，而不必 import 本仓库代码；
 * - WebPilot 自己也是 MCP Host（lib/mcp.ts）：内置工具和外部 MCP 工具在
 *   Agent 循环里平权 —— 这就是「工具生态」而不是「一堆函数」。
 *
 * 传输：stdio（本地进程，最通用的 MCP 传输方式）。
 * 浏览器：首个工具调用时懒启动 headless Chromium，进程退出时关闭。
 *
 * 启动：npm run mcp （即 tsx mcp/server.ts）
 * 调试：npx @modelcontextprotocol/inspector npm run mcp
 */

import { chromium, type Browser, type Page } from "playwright";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeTool } from "../lib/tools";

// ---- 浏览器生命周期：懒启动，进程退出时兜底关闭 ----------------------------

let pagePromise: Promise<Page> | null = null;

function getPage(): Promise<Page> {
  if (!pagePromise) {
    pagePromise = (async () => {
      const browser: Browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      process.on("exit", () => void browser.close().catch(() => {}));
      return page;
    })();
  }
  return pagePromise;
}

/** MCP tool handler → executeTool：错误统一折叠成结构化结果，不让协议层崩 */
async function call(name: string, args: Record<string, unknown>) {
  try {
    const page = await getPage();
    const result = await executeTool(name, args as any, page);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }] };
  }
}

const selector = { selector: z.string().describe("CSS 选择器，优先使用 getSnapshot 返回的 suggested_selector") };

const server = new McpServer(
  { name: "webpilot-browser", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

// 工具定义与 lib/tools.ts 的 toolSchemas 一一对应；描述同步维护
server.tool("goto", "导航到指定 URL。只能访问白名单内的域名。", { url: z.string().describe("完整 URL，含 http(s)://") }, (a) => call("goto", a));
server.tool("getSnapshot", "获取当前页面上可交互元素的精简清单，包含每个元素的建议 CSS 选择器(suggested_selector)。在点击或输入之前，先用它发现正确的选择器。", {}, () => call("getSnapshot", {}));
server.tool("getAccessibilityTree", "获取当前页面的可访问性树（YAML），用于理解页面语义结构和角色。", {}, () => call("getAccessibilityTree", {}));
server.tool("click", "点击匹配 CSS 选择器的第一个元素。", selector, (a) => call("click", a));
server.tool("type", "向输入框/文本域填入文本（会清空原有内容）。", { ...selector, text: z.string().describe("要输入的文本") }, (a) => call("type", a));
server.tool("press", "按下键盘按键，例如 Enter。", { key: z.string().describe("按键名，如 Enter / Escape") }, (a) => call("press", a));
server.tool("select", "选中下拉框（<select>）的某个选项，按选项的 value 或可见文本匹配。", { ...selector, value: z.string().describe("选项的 value 或可见文本") }, (a) => call("select", a));
server.tool("assertText", "断言匹配选择器的元素文本包含期望内容，返回通过/失败。用于验证结果。", { ...selector, expected: z.string().describe("期望包含的文本") }, (a) => call("assertText", a));
server.tool("assertCount", "断言匹配选择器的元素数量等于期望值，返回通过/失败。用于验证列表条数等。", { ...selector, expected: z.number().describe("期望的元素数量") }, (a) => call("assertCount", a));

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  // stdio 协议进程不能往 stdout 打日志（会污染协议流），一律走 stderr
  console.error("[webpilot-mcp] server ready: 9 tools on stdio");
}

main().catch((err) => {
  console.error("[webpilot-mcp] 启动失败：", err);
  process.exit(1);
});
