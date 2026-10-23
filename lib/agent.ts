import { chromium } from "playwright";
import { chat } from "./llm";
import { executeTool, toolSchemas } from "./tools";
import { isAllowedUrl } from "./guardrails";
import { recall, store } from "./memory";
import { callMcpTool, closeAll, connectMcpServers, type McpConnection } from "./mcp";

const MAX_STEPS = Number(process.env.MAX_STEPS || 10);
const OVERALL_TIMEOUT_MS = Number(process.env.OVERALL_TIMEOUT_MS || 180000);
const MAX_REFLECTIONS = Number(process.env.MAX_REFLECTIONS || 3);

const SYSTEM_PROMPT = `You are WebPilot, an agent that controls a headless browser to complete tasks using tools.

Rules:
- The page is ALREADY OPEN. Operate on it directly. Do NOT call goto again unless the task explicitly asks you to visit a different site — navigating to a domain outside the allow-list is rejected and wastes a step.
- Work step by step. Before clicking or typing, inspect the page: call getSnapshot to discover elements and their suggested_selector values.
- Use the suggested_selector values from getSnapshot when calling click / type / assertText / assertCount.
- Verify your work: after making changes, use assertText or assertCount to confirm the expected state.
- If a tool returns an error, read the message and adapt (for example, re-run getSnapshot to find the right selector). Do not repeat the exact same failing call more than twice.
- When the task is complete and verified, reply with a short final summary and do NOT call any more tools.
- The FIRST LINE of your final reply MUST be exactly "STATUS: DONE" if the task was completed and verified, or "STATUS: BLOCKED" if you could not complete it. Put the explanation on the lines after that.
- Be concise. Prefer acting over long explanations.`;

export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "step"; step: number; tool: string; args: any; result: any; screenshot: string | null }
  | { type: "final"; text: string; success: boolean }
  | {
      type: "report";
      steps: number;
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
      success: boolean;
      assertionsTotal: number;
      assertionsFailed: number;
    }
  | { type: "memory"; phase: "recall" | "store"; message: string }
  | { type: "error"; message: string };

export async function runAgent(opts: {
  task: string;
  url?: string;
  /** 客户端断开信号。不传的话，用户点了「停止」服务端仍会跑完剩余步骤。 */
  signal?: AbortSignal;
  /** 本次运行的最大步数覆盖（verify 的多步用例需要比默认更多余量） */
  maxSteps?: number;
  onEvent: (event: AgentEvent) => void;
}) {
  const { task, url, signal, onEvent } = opts;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const startedAt = Date.now();
  let promptTokens = 0;
  let completionTokens = 0;
  let stepNumber = 0;
  let assertionsTotal = 0;
  let assertionsFailed = 0;
  // 记忆模块用：失败与成功交互全程收集，任务结束后摘要入库
  const failures: { tool: string; args: unknown; error?: string; pass?: boolean }[] = [];
  const actions: string[] = [];
  let reflections = 0;

  // 消息历史 = system prompt + 用户任务 + 每轮的工具调用/结果，这就是 Agent 的"记忆"
  const messages: any[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task },
  ];

  // ---- 记忆召回：按任务语义检索历史经验，注入 prompt（失败即降级为无记忆）----
  try {
    const hits = await recall(task);
    if (hits.length > 0) {
      const lines = hits
        .map((h) => `- 任务「${h.task.slice(0, 60)}」${h.success ? "成功" : "失败"}（${h.steps} 步）\n  ${h.lessons.join("\n  ")}`)
        .join("\n");
      messages.push({
        role: "system",
        content: `历史相似任务的经验（来自过去的运行，供参考，不一定适用于当前页面）：\n${lines}`,
      });
      onEvent({
        type: "memory",
        phase: "recall",
        message: `命中 ${hits.length} 条历史经验（相似度 ${hits[0].score.toFixed(2)} 起），已注入 prompt`,
      });
    }
  } catch {
    // 记忆召回任何问题都不该挡住任务
  }

  // ---- MCP 工具生态：连外部 MCP server，外部工具与内置工具平权 ----
  // 失败只告警降级为「仅内置工具」，绝不阻断任务。
  let mcpConns: McpConnection[] = [];
  try {
    mcpConns = await connectMcpServers();
    if (mcpConns.length > 0) {
      const total = mcpConns.reduce((n, c) => n + c.schemas.length, 0);
      onEvent({ type: "status", message: `已连接 ${mcpConns.length} 个 MCP server（${total} 个外部工具可用）` });
    }
  } catch (err) {
    console.error("[mcp] 连接失败（降级为仅内置工具）：", err);
  }
  const allSchemas = [...toolSchemas, ...mcpConns.flatMap((c) => c.schemas)];

  try {
    // 可选：初始导航到用户指定的 URL
    if (url) {
      if (!isAllowedUrl(url)) {
        throw new Error(`URL 不在白名单内：${url}`);
      }
      stepNumber += 1;
      onEvent({ type: "status", message: `步骤 ${stepNumber}：打开 ${url}` });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      const result = { ok: true, url: page.url(), title: await page.title() };
      onEvent({ type: "step", step: stepNumber, tool: "goto", args: { url }, result, screenshot: await capture(page) });

      // 必须把「页面已经打开、当前地址是什么」告诉模型。
      // 否则模型不知道自己在哪一页，会自己猜一个 URL 再 goto 一次 ——
      // 猜错就被白名单拦下，连续失败几次后它直接放弃整个任务。
      messages.push({
        role: "user",
        content: `页面已经打开：${page.url()}。请直接在这个页面上操作。`,
      });
    }

    let finalText = "";
    let success = false;

    // 核心 ReAct 循环：决策 → 执行 → 观察 → 再决策
    for (let iter = 0; iter < maxSteps; iter++) {
      // 客户端一走就立刻停：否则「停止」按钮只停前端，服务端会把剩下的
      // 步骤全跑完，每次都真金白银调一次 LLM。
      if (signal?.aborted) throw new Error("客户端已断开，任务中止");
      if (Date.now() - startedAt > OVERALL_TIMEOUT_MS) {
        throw new Error("整体超时，已停止");
      }

      onEvent({ type: "status", message: `第 ${iter + 1} 轮：让模型决策下一步...` });

      const response = await chat(messages, allSchemas);
      if (response.usage) {
        promptTokens += response.usage.prompt_tokens ?? 0;
        completionTokens += response.usage.completion_tokens ?? 0;
      }

      const msg = response.choices[0]?.message;
      if (!msg) throw new Error("模型返回为空");

      // 把模型的回复（含可能的 tool_calls）压入历史
      messages.push(msg);

      const toolCalls = msg.tool_calls ?? [];

      // 没有工具调用 → 模型给出了最终结论（可能是完成，也可能是放弃）
      if (toolCalls.length === 0) {
        finalText = msg.content ?? "";

        // success 不能只看「模型不再调用工具了」—— 模型放弃任务时同样不再调用工具。
        // 优先信模型自己声明的 STATUS 行；它没写就退回「有没有失败的断言」。
        const status = finalText.match(/^\s*STATUS:\s*(DONE|BLOCKED)/i);
        success = status ? status[1].toUpperCase() === "DONE" : assertionsFailed === 0;
        // STATUS 行是给程序看的控制标记，展示给用户前去掉
        const displayText = finalText.replace(/^\s*STATUS:\s*(DONE|BLOCKED)\s*\n?/i, "").trim();

        onEvent({ type: "final", text: displayText || finalText, success });
        break;
      }

      // 执行这一步里的所有工具调用，并把结果压回历史
      let roundHadFailure = false;
      for (const call of toolCalls) {
        if (signal?.aborted) throw new Error("客户端已断开，任务中止");
        stepNumber += 1;
        const name = call.function?.name ?? "unknown";
        let args: any = {};
        try {
          const raw = call.function?.arguments;
          args = typeof raw === "string" ? JSON.parse(raw || "{}") : raw;
        } catch {
          args = {};
        }

        onEvent({ type: "status", message: `步骤 ${stepNumber}：执行工具 ${name}` });

        let result: any;
        try {
          if (name.startsWith("mcp__")) {
            // 外部 MCP 工具：按前缀找到对应 server 连接，raw 名反查后走协议调用
            const conn = mcpConns.find((c) => name.startsWith(`mcp__${c.serverName}__`));
            let rawName: string | undefined;
            for (const [raw, prefixed] of conn?.toolNames ?? []) {
              if (prefixed === name) rawName = raw;
            }
            result =
              conn && rawName
                ? await callMcpTool(conn, rawName, args)
                : { ok: false, error: `未找到 MCP 工具：${name}` };
          } else {
            result = await executeTool(name, args, page);
          }
        } catch (err: any) {
          result = { ok: false, error: String(err?.message ?? err) };
        }

        // 断言工具的 pass 是「任务是否真的完成」最硬的依据 ——
        // 模型自己的措辞可能含糊，断言结果不会。
        if (name === "assertText" || name === "assertCount") {
          assertionsTotal += 1;
          if (!result?.pass) assertionsFailed += 1;
        }

        // 记忆素材：失败和被验证有效的交互都要记
        if (result?.ok === false || result?.pass === false) {
          failures.push({ tool: name, args, error: result?.error, pass: result?.pass });
          roundHadFailure = true;
        } else if ((name === "click" || name === "type" || name === "press") && result?.ok) {
          const sel = args?.selector ? ` ${name}(${args.selector})` : ` ${name}`;
          actions.push(sel.trim());
        }

        const screenshot = await capture(page).catch(() => null);

        onEvent({ type: "step", step: stepNumber, tool: name, args, result, screenshot });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      // ---- Reflexion：失败后强制反思，而不是放任模型原样重试 ----
      // 断言未通过或工具报错时，注入一条反思消息：要求先分析原因再换策略。
      // 上限 MAX_REFLECTIONS 次，防止「反思→再失败→再反思」把步数烧光。
      if (roundHadFailure && reflections < MAX_REFLECTIONS) {
        reflections += 1;
        const lastFail = failures[failures.length - 1];
        const what = lastFail.error ?? (lastFail.pass === false ? "断言未通过" : "调用失败");
        onEvent({ type: "status", message: `第 ${reflections} 次反思：${lastFail.tool} 失败（${what}），要求换策略重试` });
        messages.push({
          role: "user",
          content:
            `刚才的 ${lastFail.tool} 调用失败了（${what}）。请先分析失败原因，` +
            `再换一种策略重试 —— 严禁重复一模一样的调用。` +
            (lastFail.pass === false
              ? `如果断言的预期值本身错了，先观察页面实际状态再修正预期。`
              : `如果是选择器/参数的问题，重新 getSnapshot 找正确的。`),
        });
      }
    }

    if (!success && !finalText) {
      finalText = `达到最大步数（${maxSteps}），任务未完成。`;
      onEvent({ type: "final", text: finalText, success: false });
    }

    onEvent({
      type: "report",
      steps: stepNumber,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      success,
      assertionsTotal,
      assertionsFailed,
    });

    // ---- 记忆写入：任务结束才入库，且不阻塞/不破坏任何结果 ----
    try {
      await store({ task, success, steps: stepNumber, failures, actions });
      onEvent({ type: "memory", phase: "store", message: `已写入经验（成功=${success}，失败点 ${failures.length} 个）` });
    } catch {
      // ignore
    }
  } catch (err: any) {
    onEvent({ type: "error", message: String(err?.message ?? err) });
  } finally {
    await closeAll(mcpConns);
    await browser.close();
  }
}

/** 截取当前页面，转成 base64 data URL，用于前端时间线展示（不喂给 LLM） */
async function capture(page: any): Promise<string> {
  const buf = await page.screenshot({ type: "jpeg", quality: 55 });
  return "data:image/jpeg;base64," + buf.toString("base64");
}
