import type { Page } from "playwright";
import type { ToolSchema } from "./llm";
import { isAllowedUrl } from "./guardrails";

/**
 * 8 个浏览器工具：导航 / 快照 / 可访问性树 / 点击 / 输入 / 按键 / 文本断言 / 数量断言。
 * 每个工具对应一个 OpenAI function-calling 的 schema + 一个执行器。
 */

export const toolSchemas: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "goto",
      description: "导航到指定 URL。只能访问白名单内的域名。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整 URL，含 http(s)://" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSnapshot",
      description:
        "获取当前页面上可交互元素的精简清单，包含每个元素的建议 CSS 选择器(suggested_selector)。" +
        "在点击或输入之前，先用它发现正确的选择器。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getAccessibilityTree",
      description: "获取当前页面的可访问性树（YAML），用于理解页面语义结构和角色。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description: "点击匹配 CSS 选择器的第一个元素。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器，优先使用 getSnapshot 返回的 suggested_selector" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type",
      description: "向输入框/文本域填入文本（会清空原有内容）。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "输入元素的 CSS 选择器" },
          text: { type: "string", description: "要输入的文本" },
        },
        required: ["selector", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "press",
      description: "按下键盘按键，例如 Enter。",
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "按键名，如 Enter / Escape" } },
        required: ["key"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assertText",
      description: "断言匹配选择器的元素文本包含期望内容，返回通过/失败。用于验证结果。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器" },
          expected: { type: "string", description: "期望包含的文本" },
        },
        required: ["selector", "expected"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "assertCount",
      description: "断言匹配选择器的元素数量等于期望值，返回通过/失败。用于验证列表条数等。",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS 选择器" },
          expected: { type: "number", description: "期望的元素数量" },
        },
        required: ["selector", "expected"],
      },
    },
  },
];

/** 执行单个工具，返回结构化结果（喂回给 LLM） */
export async function executeTool(name: string, args: any, page: Page): Promise<any> {
  switch (name) {
    case "goto": {
      const url: string = String(args.url ?? "");
      if (!isAllowedUrl(url)) {
        return { ok: false, error: `URL 不在白名单内：${url}` };
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      return { ok: true, url: page.url(), title: await page.title() };
    }

    case "getSnapshot": {
      const elements = await page.evaluate(() => {
        const selectors = "input, textarea, button, a, select, [data-testid], [id], li.todo-item";
        const els = Array.from(document.querySelectorAll(selectors));
        const seen = new Set<string>();
        const out: any[] = [];
        for (const el of els.slice(0, 80)) {
          const tag = el.tagName.toLowerCase();
          const id = el.getAttribute("id");
          const testid = el.getAttribute("data-testid");
          const text = ((el.textContent || "").trim().replace(/\s+/g, " ")).slice(0, 60);
          const placeholder = (el as HTMLInputElement).placeholder || "";
          const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "";
          const suggested = testid
            ? `[data-testid="${testid}"]`
            : id
              ? `#${id}`
              : cls
                ? `${tag}.${cls}`
                : tag;
          if (seen.has(suggested)) continue;
          seen.add(suggested);
          out.push({ tag, text, placeholder, suggested_selector: suggested });
        }
        return out;
      });
      return { ok: true, elements };
    }

    case "getAccessibilityTree": {
      const snapshot = await page.locator("body").ariaSnapshot();
      return { ok: true, snapshot: snapshot || "(empty)" };
    }

    case "click": {
      const selector: string = String(args.selector ?? "");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "visible", timeout: 8000 });
      await loc.click();
      return { ok: true, clicked: selector };
    }

    case "type": {
      const selector: string = String(args.selector ?? "");
      const text: string = String(args.text ?? "");
      const loc = page.locator(selector).first();
      await loc.waitFor({ state: "visible", timeout: 8000 });
      await loc.fill(text);
      return { ok: true, filled: selector };
    }

    case "press": {
      await page.keyboard.press(String(args.key ?? "Enter"));
      return { ok: true, pressed: String(args.key ?? "Enter") };
    }

    case "assertText": {
      const selector: string = String(args.selector ?? "");
      const expected: string = String(args.expected ?? "");
      const loc = page.locator(selector);
      const count = await loc.count();
      if (count === 0) {
        return { ok: false, pass: false, reason: `选择器 "${selector}" 没有匹配到元素` };
      }
      // 用 innerText 而不是 textContent：后者会把 <style>/<script> 的源码也算成
      // 「元素文本」。实测在 <html> 上断言 addEventListener 会通过，而且会把
      // 2KB 的 CSS/JS 源码原样回灌给模型 —— 既误判又白烧 token。
      const raw = (await loc.first().innerText()).replace(/\s+/g, " ").trim();
      const MAX = 300;
      const actual = raw.slice(0, MAX);
      const pass = actual.includes(expected);
      return { ok: true, pass, actual, expected, ...(raw.length > MAX ? { truncated: true } : {}) };
    }

    case "assertCount": {
      const selector: string = String(args.selector ?? "");
      const expected: number = Number(args.expected);
      const count = await page.locator(selector).count();
      const result: any = { ok: true, pass: count === expected, actual: count, expected };
      // 「0 个」有两层含义：列表真的是空的，或者选择器写错了。两者在结果上
      // 完全一样，所以 expected=0 的断言会假通过。把这个不确定性明确告诉模型，
      // 让它先核对选择器再下结论。
      if (count === 0) {
        result.warning =
          `选择器 "${selector}" 没有匹配到任何元素。这既可能是「列表确实是空的」，` +
          `也可能是「选择器本身写错了」——下结论前请用 getSnapshot 核对一次选择器。`;
      }
      return result;
    }

    default:
      return { ok: false, error: `未知工具：${name}` };
  }
}
