"use client";

import { useEffect, useRef, useState } from "react";

type StepEvent = {
  type: "step";
  step: number;
  tool: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  screenshot: string | null;
};

type FinalEvent = { type: "final"; text: string; success: boolean };

type MemoryEvent = { type: "memory"; phase: "recall" | "store"; message: string };

type ReportEvent = {
  type: "report";
  steps: number;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  success: boolean;
  assertionsTotal: number;
  assertionsFailed: number;
};

const DEFAULT_URL = "http://localhost:3000/todo.html";
const DEFAULT_TASK =
  "打开这个待办事项页面，依次添加 3 条待办：买牛奶、写周报、预约体检。然后断言列表里恰好有 3 条待办。";

export default function Home() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [task, setTask] = useState(DEFAULT_TASK);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState("");
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [final, setFinal] = useState<FinalEvent | null>(null);
  const [memory, setMemory] = useState<MemoryEvent[]>([]);
  const [report, setReport] = useState<ReportEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 访问口令只在客户端保存（localStorage），不进仓库、不进日志。
  // 服务端没设 ACCESS_TOKEN 时这个字段用不上，填了也不会发副作用。
  useEffect(() => {
    setToken(localStorage.getItem("webpilot-token") ?? "");
  }, []);

  function updateToken(v: string) {
    setToken(v);
    if (v) localStorage.setItem("webpilot-token", v);
    else localStorage.removeItem("webpilot-token");
  }

  function handleEvent(evt: any) {
    switch (evt.type) {
      case "status":
        setStatus(evt.message);
        break;
      case "step":
        setSteps((prev) => [...prev, evt]);
        break;
      case "final":
        setFinal(evt);
        break;
      case "memory":
        setMemory((prev) => [...prev, evt]);
        break;
      case "report":
        setReport(evt);
        break;
      case "error":
        setError(evt.message);
        break;
    }
  }

  async function run() {
    setSteps([]);
    setFinal(null);
    setReport(null);
    setMemory([]);
    setError(null);
    setStatus("正在启动浏览器...");
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-webpilot-token": token } : {}),
        },
        body: JSON.stringify({ url, task }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        if (res.status === 401) {
          throw new Error("需要访问口令：服务端开启了 ACCESS_TOKEN 校验，请在下方填入口令");
        }
        throw new Error(`请求失败 (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            // 忽略解析失败的行
          }
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
      setStatus("");
    }
  }

  function stop() {
    abortRef.current?.abort();
    setRunning(false);
    setStatus("");
  }

  return (
    <main className="app">
      <header className="topbar">
        <h1>
          WebPilot <span>自然语言驱动的浏览器自动化 Agent</span>
        </h1>
        <p className="subtitle">LLM 规划 → Playwright 执行 → 断言校验，全程可视化</p>
      </header>

      <section className="controls">
        <label>
          <span>目标 URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} disabled={running} />
        </label>
        <label>
          <span>任务（自然语言）</span>
          <textarea rows={3} value={task} onChange={(e) => setTask(e.target.value)} disabled={running} />
        </label>
        <label>
          <span>访问口令（服务端设置 ACCESS_TOKEN 后必填）</span>
          <input
            type="password"
            value={token}
            onChange={(e) => updateToken(e.target.value)}
            placeholder="公开部署实例的访问口令；本地开发留空"
            disabled={running}
          />
        </label>
        <div className="controls-actions">
          {!running ? (
            <button className="run" onClick={run} disabled={!task.trim()}>
              运行 Agent
            </button>
          ) : (
            <button className="stop" onClick={stop}>
              停止
            </button>
          )}
        </div>
      </section>

      {status && (
        <div className="status">
          {running && <span className="dot" />}
          {status}
        </div>
      )}

      {steps.length > 0 && (
        <section className="timeline">
          <h2>执行时间线</h2>
          {steps.map((s) => (
            <div className="step" key={s.step}>
              <div className="step-head">
                <span className="step-no">#{s.step}</span>
                <span className="tool">{s.tool}</span>
              </div>
              <div className="step-body">
                <div className="kv">
                  <span className="k">args</span>
                  <code>{JSON.stringify(s.args)}</code>
                </div>
                <div className="kv">
                  <span className="k">result</span>
                  <code>{String(JSON.stringify(s.result)).slice(0, 400)}</code>
                </div>
                {s.screenshot && (
                  <img className="shot" src={s.screenshot} alt={`步骤 ${s.step} 截图`} />
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {memory.length > 0 && (
        <section className="memory">
          {memory.map((m, i) => (
            <div className={m.phase === "recall" ? "mem-recall" : "mem-store"} key={i}>
              {m.phase === "recall" ? "🧠 召回" : "✍️ 写入"}　{m.message}
            </div>
          ))}
        </section>
      )}

      {final && (
        <section className="result">
          <h2>{final.success ? "任务完成" : "任务未完全完成"}</h2>
          <p>{final.text}</p>
        </section>
      )}

      {report && (
        <section className="report">
          <h2>报告</h2>
          <div className="metrics">
            <div>
              <span>步数</span>
              <b>{report.steps}</b>
            </div>
            <div>
              <span>耗时</span>
              <b>{(report.durationMs / 1000).toFixed(1)}s</b>
            </div>
            <div>
              <span>Prompt tokens</span>
              <b>{report.promptTokens}</b>
            </div>
            <div>
              <span>Completion tokens</span>
              <b>{report.completionTokens}</b>
            </div>
            <div>
              <span>断言</span>
              <b>
                {report.assertionsTotal === 0
                  ? "—"
                  : `${report.assertionsTotal - report.assertionsFailed}/${report.assertionsTotal}`}
              </b>
            </div>
            <div>
              <span>结果</span>
              <b>{report.success ? "通过" : "未通过"}</b>
            </div>
          </div>
        </section>
      )}

      {error && <div className="error">出错：{error}</div>}
    </main>
  );
}
