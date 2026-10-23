/**
 * WebPilot 作为 MCP Host：连接外部 MCP server，把它们的工具并入 Agent 工具箱。
 *
 * 设计要点：
 * - 工具名加 `mcp__<server>__<tool>` 前缀：内置工具（goto/click…）与外部工具
 *   天然可能重名（比如连自己的 mcp/server.ts），前缀避免冲突，也让模型一眼
 *   看出工具来源；
 * - MCP 工具的 inputSchema 就是 JSON Schema，OpenAI function calling 的
 *   parameters 也是 —— 直接透传，无需转换；
 * - 任何连接/列举失败只告警不阻断：外部工具是增强，不是依赖；
 * - 环境变量 WEBPILOT_MCP_SERVERS（JSON 数组），例如：
 *   [{"name":"browser","command":"npx","args":["tsx","mcp/server.ts"]}]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolSchema } from "./llm";

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
}

export interface McpConnection {
  serverName: string;
  client: Client;
  /** 原始 MCP 工具名 → 前缀后的 Agent 工具名 */
  toolNames: Map<string, string>;
  schemas: ToolSchema[];
}

export function parseServerConfigs(): McpServerConfig[] {
  const raw = process.env.WEBPILOT_MCP_SERVERS;
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    return parsed.filter((c: any) => c?.name && c?.command);
  } catch (err) {
    console.error("[mcp] WEBPILOT_MCP_SERVERS 解析失败，忽略外部工具：", err);
    return [];
  }
}

export async function connectMcpServers(): Promise<McpConnection[]> {
  const connections: McpConnection[] = [];
  for (const cfg of parseServerConfigs()) {
    try {
      const client = new Client({ name: "webpilot-host", version: "1.0.0" });
      const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [] });
      await client.connect(transport);

      const { tools } = await client.listTools();
      const toolNames = new Map<string, string>();
      const schemas: ToolSchema[] = [];
      for (const t of tools) {
        const prefixed = `mcp__${cfg.name}__${t.name}`;
        toolNames.set(t.name, prefixed);
        schemas.push({
          type: "function",
          function: {
            name: prefixed,
            description: t.description || t.name,
            // MCP inputSchema 与 function calling parameters 同为 JSON Schema
            parameters: (t.inputSchema as any) ?? { type: "object", properties: {} },
          },
        });
      }
      connections.push({ serverName: cfg.name, client, toolNames, schemas });
      console.error(`[mcp] 已连接 ${cfg.name}：${schemas.length} 个工具`);
    } catch (err) {
      console.error(`[mcp] 连接 ${cfg.name} 失败（跳过）：`, err instanceof Error ? err.message : err);
    }
  }
  return connections;
}

/** 调用外部 MCP 工具。返回值直接序列化为 tool 观察结果。 */
export async function callMcpTool(conn: McpConnection, rawName: string, args: any): Promise<any> {
  const result: any = await conn.client.callTool({ name: rawName, arguments: args ?? {} });
  // MCP 结果是 content 数组；拼成纯文本再还原为结构化对象（我们的工具都返回 JSON 文本）
  const text = (result.content ?? [])
    .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return { ok: true, text };
  }
}

export async function closeAll(connections: McpConnection[]): Promise<void> {
  for (const c of connections) {
    try {
      await c.client.close();
    } catch {
      /* 忽略关闭错误 */
    }
  }
}
