/**
 * WebPilot 可复现验证脚本 —— npm run verify
 *
 * 为什么需要它：Agent 有随机性，「跑一次成功」说明不了问题。这个脚本把
 * 「任务 → 实测结果」固定下来，每跑一次就输出步数 / 耗时 / token 成本，
 * 让「改了 prompt 之后是变好还是变差」有数字可查，而不是靠感觉。
 *
 * 脚本自己起一个静态服务器提供 public/todo.html，跑完自动关掉 ——
 * 不需要先开着 npm run dev。前提是 .env.local 里有可用的 LLM_API_KEY。
 *
 *   npm run verify            # 跑全部用例
 *   npm run verify -- --only 2  # 只跑第 2 条
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, resolve } from "node:path";
import { tmpdir } from "node:os";

const PORT = 3101;

interface Case {
  id: number;
  name: string;
  task: string;
  /** memory=true 的用例是特殊流程：同任务连跑两次，验证记忆召回收益 */
  memory?: boolean;
}

const CASES: Case[] = [
  {
    id: 1,
    name: "添加 3 条待办 → 断言数量为 3",
    task: "打开这个待办事项页面，依次添加 3 条待办：买牛奶、写周报、预约体检。然后断言列表里恰好有 3 条待办。",
  },
  {
    id: 2,
    name: "添加 1 条指定内容 → 断言文本存在",
    task: "打开这个待办事项页面，添加一条待办「下午三点开会」，然后断言页面上确实出现了这条内容。",
  },
  {
    id: 3,
    name: "什么都不加 → 断言数量为 0",
    task: "打开这个待办事项页面。不要添加或修改任何内容，直接断言列表里的条目数量是 0。",
  },
  {
    id: 4,
    name: "记忆收益：同任务连跑两次，第二次应命中经验",
    task: "打开这个待办事项页面，依次添加 3 条待办：买牛奶、写周报、预约体检。然后断言列表里恰好有 3 条待办。",
    memory: true,
  },
];

interface CaseResult {
  id: number;
  name: string;
  steps: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  assertions: number;
  failedAssertions: number;
  agentSaidSuccess: boolean;
  error?: string;
}

/** .env.local 必须在 lib/agent 加载之前注入 —— 那个模块在 import 时就读 process.env */
function loadEnvLocal(): void {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) {
    console.error("✗ 找不到 .env.local —— 先 cp .env.example .env.local 并填入 LLM_API_KEY");
    process.exit(1);
  }
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
  // 验证脚本自己提供待测页面，白名单要放行本地地址
  process.env.ALLOWED_DOMAINS = "localhost,127.0.0.1";
}

/** 提供 public/ 下的静态文件，替代 npm run dev 的静态资源部分 */
function startStaticServer(port: number) {
  const root = resolve(process.cwd(), "public");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };

  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    const rel = normalize(pathname === "/" ? "/todo.html" : pathname).replace(/^(\.\.[/\\])+/, "");
    try {
      const buf = await readFile(join(root, rel));
      res.writeHead(200, { "Content-Type": types[extname(rel)] ?? "application/octet-stream" });
      res.end(buf);
    } catch (err) {
      // 不要静默 404 —— 上一版就是被这里吞掉了「readFile 取到的是回调版」的
      // TypeError，表现成「页面能打开但内容全是 404」，排查了很久。
      console.error(`  [static] 读取失败 ${rel}：${(err as Error).message}`);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404");
    }
  });

  return new Promise<ReturnType<typeof createServer>>((ok) => {
    server.listen(port, () => ok(server));
  });
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { runAgent } = await import("../lib/agent");
  const memory = await import("../lib/memory");

  // verify 的记忆走独立目录：不污染日常运行的记忆，也保证每次验证从干净状态开始
  process.env.MEMORY_DIR = join(tmpdir(), "webpilot-verify-memory");
  memory.clear();

  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx >= 0 ? Number(process.argv[onlyIdx + 1]) : null;
  const cases = only ? CASES.filter((c) => c.id === only) : CASES;

  if (cases.length === 0) {
    console.error(`✗ 没有 id 为 ${only} 的用例`);
    process.exit(1);
  }

  const server = await startStaticServer(PORT);
  const pageUrl = `http://127.0.0.1:${PORT}/todo.html`;
  const results: CaseResult[] = [];

  /** 跑一次任务并收集结果 + 记忆事件 */
  async function runOnce(c: Case, label: string): Promise<{ result: CaseResult; memoryEvents: any[] }> {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`用例 ${c.id}：${c.name}${label ? `（${label}）` : ""}`);
    console.log(`${"─".repeat(60)}`);

    let steps = 0;
    let assertions = 0;
    let failedAssertions = 0;
    let report: any = null;
    let error: string | undefined;
    const memoryEvents: any[] = [];

    await runAgent({
      task: c.task,
      url: pageUrl,
      onEvent: (e: any) => {
        if (e.type === "step") {
          steps += 1;
          if (e.tool.startsWith("assert")) {
            assertions += 1;
            if (!e.result?.pass) failedAssertions += 1;
            const mark = e.result?.pass ? "✓" : "✗";
            console.log(`  ${mark} [${e.step}] ${e.tool}  ${JSON.stringify(e.result)}`);
          } else {
            const detail = JSON.stringify(e.result);
            console.log(`    [${e.step}] ${e.tool}  ${detail.length > 110 ? detail.slice(0, 110) + "…" : detail}`);
          }
        } else if (e.type === "final") {
          console.log(`  → ${e.text}`);
        } else if (e.type === "memory") {
          memoryEvents.push(e);
          console.log(`  🧠 [记忆·${e.phase}] ${e.message}`);
        } else if (e.type === "report") {
          report = e;
        } else if (e.type === "error") {
          error = e.message;
          console.log(`  !! ${e.message}`);
        }
      },
    });

    return {
      result: {
        id: c.id,
        name: c.name,
        steps,
        durationMs: report?.durationMs ?? 0,
        promptTokens: report?.promptTokens ?? 0,
        completionTokens: report?.completionTokens ?? 0,
        assertions,
        failedAssertions,
        agentSaidSuccess: Boolean(report?.success) && !error,
        error,
      },
      memoryEvents,
    };
  }

  try {
    for (const c of cases) {
      if (c.memory) {
        // 记忆收益用例：第 1 次冷启动写入经验，第 2 次应命中并注入 prompt
        memory.clear();
        const r1 = await runOnce(c, "第 1 次 · 冷启动");
        const r2 = await runOnce(c, "第 2 次 · 应命中记忆");

        const stored = r1.memoryEvents.some((e) => e.phase === "store");
        const recalled = r2.memoryEvents.some((e) => e.phase === "recall");
        const bothOk = r1.result.agentSaidSuccess && r2.result.agentSaidSuccess
          && r1.result.failedAssertions === 0 && r2.result.failedAssertions === 0;
        const ok = stored && recalled && bothOk;

        console.log(
          `\n  记忆判定：写入${stored ? "✓" : "✗"} 召回${recalled ? "✓" : "✗"} 两次都通过${bothOk ? "✓" : "✗"}`,
        );
        console.log(
          `  步数对比：冷启动 ${r1.result.steps} 步 → 带记忆 ${r2.result.steps} 步` +
            (r2.result.steps < r1.result.steps ? "（↓ 记忆生效）" : ""),
        );
        console.log(
          `  token 对比：${r1.result.promptTokens + r1.result.completionTokens} → ${r2.result.promptTokens + r2.result.completionTokens}`,
        );

        results.push({
          ...r2.result,
          name: `${c.name}（${r1.result.steps}→${r2.result.steps} 步）`,
          agentSaidSuccess: ok,
        });
      } else {
        memory.clear(); // 每条普通用例都从干净记忆开始，互不干扰
        const { result } = await runOnce(c, "");
        results.push(result);
      }
    }
  } finally {
    server.close();
  }

  // ---- 汇总 ----
  console.log(`\n${"=".repeat(60)}`);
  console.log("汇总");
  console.log("=".repeat(60));
  console.log(
    ["用例", "步数", "耗时", "prompt", "completion", "断言", "结果"]
      .map((h, i) => pad(h, [26, 6, 9, 9, 12, 7, 8][i]))
      .join(""),
  );

  let passed = 0;
  for (const r of results) {
    // 判定标准：Agent 自己认为成功 + 没有任何断言失败
    const ok = r.agentSaidSuccess && r.failedAssertions === 0;
    if (ok) passed += 1;
    console.log(
      [
        pad(`${r.id}. ${r.name}`, 26),
        pad(String(r.steps), 6),
        pad(`${(r.durationMs / 1000).toFixed(1)}s`, 9),
        pad(String(r.promptTokens), 9),
        pad(String(r.completionTokens), 12),
        pad(r.assertions === 0 ? "—" : `${r.assertions - r.failedAssertions}/${r.assertions}`, 7),
        ok ? "通过" : "未通过",
      ].join(""),
    );
  }

  const totalPrompt = results.reduce((s, r) => s + r.promptTokens, 0);
  const totalCompletion = results.reduce((s, r) => s + r.completionTokens, 0);
  console.log(
    `\n通过 ${passed}/${results.length}　` +
      `总 token：${totalPrompt + totalCompletion}（prompt ${totalPrompt} + completion ${totalCompletion}）`,
  );

  process.exit(passed === results.length ? 0 : 1);
}

/** 中英混排时按显示宽度补空格，让表格对齐 */
function pad(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(1, width - w));
}

main().catch((e) => {
  console.error("验证脚本异常：", e);
  process.exit(1);
});
