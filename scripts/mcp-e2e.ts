/**
 * MCP 端到端自检：WebPilot 作为 Host 连自己的 MCP server，
 * 验证「列工具 → 导航 → 快照 → 断言」全链路协议可用。
 *
 * 运行：npm run mcp:e2e （不调 LLM，不出 token）
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = 3102;

function startStaticServer(port: number) {
  const root = join(process.cwd(), "public");
  const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  return new Promise<{ close: () => void }>((resolve) => {
    const srv = createServer((req, res) => {
      const path = normalizePath(req.url ?? "/");
      const file = join(root, path);
      try {
        const body = readFileSync(file);
        res.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    srv.listen(port, "127.0.0.1", () => resolve({ close: () => srv.close() }));
  });
}

function normalizePath(u: string): string {
  const p = decodeURIComponent(u.split("?")[0]);
  const clean = p.replace(/\.{2,}/g, "").replace(/\/+/g, "/");
  return clean === "/" ? "/todo.html" : clean;
}

async function main(): Promise<number> {
  const srv = await startStaticServer(PORT);

  const transport = new StdioClientTransport({
    command: "./node_modules/.bin/tsx",
    args: ["mcp/server.ts"],
  });
  const client = new Client({ name: "webpilot-mcp-e2e", version: "1.0.0" });
  await client.connect(transport);

  let failed = false;
  try {
    const { tools } = await client.listTools();
    console.log(`✓ 列出 ${tools.length} 个工具:`, tools.map((t: any) => t.name).sort().join(", "));
    if (tools.length !== 9) throw new Error(`期望 9 个工具，实际 ${tools.length}`);

    const r1: any = await client.callTool({ name: "goto", arguments: { url: `http://127.0.0.1:${PORT}/todo.html` } });
    const goto = JSON.parse(r1.content[0].text);
    console.log(`✓ goto -> "${goto.title}"`);
    if (!goto.ok) throw new Error("goto 失败");

    const r2: any = await client.callTool({ name: "getSnapshot", arguments: {} });
    const snap = JSON.parse(r2.content[0].text);
    console.log(`✓ 快照 ${snap.elements.length} 个可交互元素`);
    if (snap.elements.length === 0) throw new Error("快照为空");

    const r3: any = await client.callTool({ name: "assertText", arguments: { selector: "h1", expected: "待办" } });
    const assert = JSON.parse(r3.content[0].text);
    console.log(`✓ assertText pass=${assert.pass}`);
    if (!assert.ok) throw new Error("断言执行失败");
  } catch (err) {
    failed = true;
    console.error("✗", err instanceof Error ? err.message : err);
  } finally {
    await client.close();
    srv.close();
  }
  console.log(failed ? "E2E FAILED" : "E2E OK");
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code));
