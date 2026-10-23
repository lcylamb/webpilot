import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/agent
 * body: { url?: string, task: string }
 * 响应：application/x-ndjson 流，逐行 JSON 事件：
 *   {type:"status"|"step"|"final"|"report"|"error"}
 */
export async function POST(req: Request) {
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
