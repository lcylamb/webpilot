import { timingSafeEqual, createHash } from "crypto";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * 访问控制：设置了 ACCESS_TOKEN 时，请求必须带 x-webpilot-token 头。
 * 公网部署时用它挡住陌生流量烧 LLM 额度；本地开发不设即不启用。
 */
function checkAuth(req: Request): Response | null {
  const expected = process.env.ACCESS_TOKEN?.trim();
  if (!expected) return null;

  const provided = req.headers.get("x-webpilot-token") ?? "";
  // 先哈希再比较，等长且不泄露时序信息
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  if (a.length === b.length && timingSafeEqual(a, b)) return null;

  return Response.json(
    { error: "未授权：请在页面设置中填入访问口令（ACCESS_TOKEN）" },
    { status: 401 },
  );
}

/**
 * POST /api/agent
 * body: { url?: string, task: string }
 * 响应：application/x-ndjson 流，逐行 JSON 事件：
 *   {type:"status"|"step"|"final"|"report"|"error"}
 */
export async function POST(req: Request) {
  const unauthorized = checkAuth(req);
  if (unauthorized) return unauthorized;

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    // ignore
  }

  const task: string = String(body.task ?? "").trim();
  const url: string = String(body.url ?? "").trim();

  if (!task) {
    return Response.json({ error: "task 不能为空" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // 客户端断开时忽略
        }
      };
      try {
        // 把请求的中断信号透传下去：用户点「停止」或关掉页面时，
        // 服务端要立刻停下，而不是把剩余步骤全跑完白烧 token。
        await runAgent({ task, url, signal: req.signal, onEvent: send });
        send({ type: "done" });
      } catch (err: any) {
        send({ type: "error", message: String(err?.message ?? err) });
      } finally {
        try {
          controller.close();
        } catch {
          // ignore
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
