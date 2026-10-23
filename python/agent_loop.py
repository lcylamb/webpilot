"""WebPilot 的 Python 版实现：同一个 ReAct 循环，换一种语言。

为什么要有这个文件：
- TypeScript 版（lib/agent.ts）是完整产品；这一份是「同一设计的 Python 表达」，
  用来证明循环本身不绑定语言 —— function calling 的核心就三件事：
  把工具 schema 发给模型、解析 tool_calls、把结果以 role=tool 压回历史。
- 结构与 TS 版一一对应，方便对照阅读：SYSTEM_PROMPT / TOOLS / run_agent()。

运行方式：
  # 真实运行（需要 DEEPSEEK_API_KEY，浏览器工具需要 playwright）：
  pip install openai playwright && playwright install chromium
  python agent_loop.py "打开 https://example.com 并断言标题包含 Example"

  # 逻辑自检（不联网、不开浏览器，用假 LLM 驱动循环）：
  python agent_loop.py --selftest
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Callable

# ---------------------------------------------------------------------------
# 1. 系统提示词 —— 和 TS 版同一套行为约束
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "你是一个浏览器自动化 Agent。每轮你可以调用一个工具，观察结果后再决策。\n"
    "规则：\n"
    "1. 先用观察类工具（get_snapshot / accessibility_tree）了解页面，再交互；\n"
    "2. 任务中的「断言」要求必须用 assert_text / assert_count 完成并看到 pass=true；\n"
    "3. 不确定选择器时先拿快照，禁止凭空猜测；\n"
    "4. 任务完成后，最后一行输出 STATUS: success 或 STATUS: failed。"
)

MAX_STEPS = 10
MAX_REFLECTIONS = 3


# ---------------------------------------------------------------------------
# 2. 工具 schema —— OpenAI function calling 格式，与 TS 版的 toolSchemas 等价
# ---------------------------------------------------------------------------
TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "goto",
            "description": "导航到指定 URL",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_snapshot",
            "description": "获取页面可见元素的精简快照，含建议 CSS 选择器",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "click",
            "description": "点击元素",
            "parameters": {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "type_text",
            "description": "向输入框填入文本（先清空）",
            "parameters": {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "text": {"type": "string"},
                },
                "required": ["selector", "text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "assert_text",
            "description": "断言页面上存在/不存在指定文本",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "negate": {"type": "boolean", "description": "true=断言不存在"},
                },
                "required": ["text"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# 3. 工具执行器 —— 浏览器版用 playwright；这里同时定义一个内存假页面供自检
# ---------------------------------------------------------------------------
def make_browser_tools() -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
    """真实浏览器工具集。playwright 缺失时抛出带安装指引的异常。"""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        raise SystemExit(
            "需要 playwright：pip install playwright && playwright install chromium"
        ) from e

    pw = sync_playwright().start()
    browser = pw.chromium.launch(headless=True)
    page = browser.new_page()

    def goto(args: dict[str, Any]) -> dict[str, Any]:
        page.goto(args["url"], wait_until="domcontentloaded", timeout=45_000)
        return {"ok": True, "title": page.title()}

    def get_snapshot(_: dict[str, Any]) -> dict[str, Any]:
        boxes = page.eval_on_selector_all(
            "button, a, input, select, textarea",
            "els => els.slice(0, 40).map(el => ({tag: el.tagName, text: (el.textContent||el.value||el.placeholder||'').trim().slice(0,30), sel: el.id ? '#'+el.id : (el.className ? el.tagName+'.'+String(el.className).split(' ')[0] : el.tagName)}))",
        )
        return {"ok": True, "elements": boxes}

    def click(args: dict[str, Any]) -> dict[str, Any]:
        page.click(args["selector"], timeout=10_000)
        return {"ok": True}

    def type_text(args: dict[str, Any]) -> dict[str, Any]:
        page.fill(args["selector"], args["text"], timeout=10_000)
        return {"ok": True}

    def assert_text(args: dict[str, Any]) -> dict[str, Any]:
        body = page.inner_text("body")
        found = args["text"] in body
        if args.get("negate"):
            found = not found
        return {"ok": True, "pass": found, "text": args["text"]}

    tools = {
        "goto": goto,
        "get_snapshot": get_snapshot,
        "click": click,
        "type_text": type_text,
        "assert_text": assert_text,
    }
    # 优雅退出：进程结束时关掉浏览器
    import atexit

    atexit.register(lambda: (browser.close(), pw.stop()))
    return tools


def make_fake_tools() -> dict[str, Callable[[dict[str, Any]], dict[str, Any]]]:
    """自检用：内存假页面，行为可预测，用来验证循环机制而非浏览器交互。"""
    state = {"url": "", "items": []}

    def goto(args: dict[str, Any]) -> dict[str, Any]:
        state["url"] = args["url"]
        return {"ok": True, "title": "fake"}

    def get_snapshot(_: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "elements": [{"sel": "#add-btn", "text": "add"}]}

    def click(args: dict[str, Any]) -> dict[str, Any]:
        if args["selector"] == "#add-btn":
            state["items"].append(f"item-{len(state['items']) + 1}")
        return {"ok": True}

    def type_text(args: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True}

    def assert_text(args: dict[str, Any]) -> dict[str, Any]:
        found = args["text"] in json.dumps(state)
        return {"ok": True, "pass": found if not args.get("negate") else not found}

    return {
        "goto": goto,
        "get_snapshot": get_snapshot,
        "click": click,
        "type_text": type_text,
        "assert_text": assert_text,
    }


# ---------------------------------------------------------------------------
# 4. ReAct 循环 —— 与 lib/agent.ts 的 while 循环逐步对应
# ---------------------------------------------------------------------------
def run_agent(
    task: str,
    url: str,
    tools: dict[str, Callable[[dict[str, Any]], dict[str, Any]]],
    client: Any,
    model: str = "deepseek-chat",
    on_event: Callable[[str, dict[str, Any]], None] = lambda t, e: None,
) -> dict[str, Any]:
    """跑一个任务，返回 {success, steps, final}。

    与 TS 版相同的三个机制：
    - 消息历史即记忆：tool 结果永远以 role=tool 追加；
    - 断言结果决定成败：模型口头说完成不算，assert pass 才算；
    - Reflexion：失败后注入反思消息，禁止原样重试（上限 3 次）。
    """
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"任务：{task}\n起始页面：{url}"},
    ]

    steps = 0
    reflections = 0
    last_assert_pass: bool | None = None
    final = ""

    while steps < MAX_STEPS:
        steps += 1
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            tools=TOOLS,
            temperature=0,
        )
        msg = resp.choices[0].message

        # —— 出口 1：模型不再调工具，输出结论文本 ——
        if not msg.tool_calls:
            final = msg.content or ""
            success = "STATUS: success" in final and last_assert_pass is not False
            on_event("final", {"text": final, "success": success})
            return {"success": success, "steps": steps, "final": final}

        # —— 执行本轮所有工具调用并压回历史 ——
        messages.append(
            {"role": "assistant", "content": msg.content or "", "tool_calls": [tc.model_dump() for tc in msg.tool_calls]}
        )
        failed_this_round = False
        for tc in msg.tool_calls:
            name = tc.function.name
            args = json.loads(tc.function.arguments or "{}")
            try:
                result = tools[name](args)
            except Exception as exc:  # 工具异常也作为观察结果喂回去
                result = {"ok": False, "error": str(exc)}
            on_event("step", {"tool": name, "args": args, "result": result})
            if name in ("assert_text", "assert_count"):
                last_assert_pass = bool(result.get("pass"))
                failed_this_round = failed_this_round or not result.get("pass")
            elif result.get("ok") is False:
                failed_this_round = True
            messages.append(
                {"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result, ensure_ascii=False)}
            )

        # —— Reflexion：失败后强制反思，而不是放任原样重试 ——
        if failed_this_round and reflections < MAX_REFLECTIONS:
            reflections += 1
            on_event("reflection", {"round": reflections})
            messages.append(
                {
                    "role": "user",
                    "content": "刚才的调用失败了。先分析原因，再换一种策略重试；"
                    "严禁重复一模一样的调用。如果是断言预期值本身错了，"
                    "先观察页面实际状态再修正预期。",
                }
            )

    return {"success": False, "steps": steps, "final": "达到最大步数，任务未完成"}


# ---------------------------------------------------------------------------
# 5. 入口：真实模式 / 自检模式
# ---------------------------------------------------------------------------
def selftest() -> int:
    """不联网验证循环机制：假 LLM 按脚本发 tool_calls，检查消息流转与 Reflexion。"""

    class FakeMessage:
        def __init__(self, content, tool_calls=None):
            self.content = content
            self.tool_calls = tool_calls

    class FakeTC:
        def __init__(self, name, args):
            self.id = f"call_{name}"
            self.function = type("F", (), {"name": name, "arguments": json.dumps(args)})()

        def model_dump(self):
            return {"id": self.id, "type": "function", "function": {"name": self.function.name, "arguments": self.function.arguments}}

    # 脚本：点两次加号 → 断言失败一次（触发 Reflexion）→ 换正确断言 → 收尾
    script = [
        FakeMessage(None, [FakeTC("goto", {"url": "http://x/todo"})]),
        FakeMessage(None, [FakeTC("click", {"selector": "#add-btn"})]),
        FakeMessage(None, [FakeTC("click", {"selector": "#add-btn"})]),
        FakeMessage(None, [FakeTC("assert_text", {"text": "item-9"})]),  # 故意失败
        FakeMessage(None, [FakeTC("assert_text", {"text": "item-2"})]),  # 修正
        FakeMessage("已完成两条断言\nSTATUS: success"),
    ]

    # 假客户端：按「历史里的 assistant 轮数」回放脚本，模拟真实多轮对话
    class FakeCompletions:
        @staticmethod
        def create(**kwargs):
            i = sum(1 for m in kwargs["messages"] if m["role"] == "assistant")
            msg = script[min(i, len(script) - 1)]

            class Resp:
                choices = [type("C", (), {"message": msg})()]

            return Resp()

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    events: list[tuple[str, dict[str, Any]]] = []
    outcome = run_agent(
        task="加两条待办并断言",
        url="http://x/todo",
        tools=make_fake_tools(),
        client=FakeClient(),
        on_event=lambda t, e: events.append((t, e)),
    )

    # 断言循环机制
    assert outcome["success"] is True, outcome
    assert outcome["steps"] == 6, outcome
    kinds = [t for t, _ in events]
    assert "reflection" in kinds, f"Reflexion 未触发: {kinds}"
    print("selftest OK:", outcome)
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--selftest":
        return selftest()

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        raise SystemExit("缺少 DEEPSEEK_API_KEY 环境变量")
    from openai import OpenAI

    client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
    task = sys.argv[1] if len(sys.argv) > 1 else "打开页面并断言标题包含 Example"
    url = sys.argv[2] if len(sys.argv) > 2 else "https://example.com"

    t0 = time.time()
    outcome = run_agent(
        task=task,
        url=url,
        tools=make_browser_tools(),
        client=client,
        on_event=lambda t, e: print(f"[{t}]", json.dumps(e, ensure_ascii=False)[:160]),
    )
    print(json.dumps({**outcome, "elapsed": round(time.time() - t0, 1)}, ensure_ascii=False))
    return 0 if outcome["success"] else 1


if __name__ == "__main__":
    sys.exit(main())
