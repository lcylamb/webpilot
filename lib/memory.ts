import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * WebPilot 记忆模块 —— 任务经验的向量存储与召回（RAG）。
 *
 * 做什么：每次任务跑完，把「任务 + 成败 + 踩坑过程」确定性摘要成一条经验，
 * 用本地 embedding 模型转成向量存进 JSON 文件；下次跑新任务时，先按语义
 * 相似度检索 top-k 条历史经验注入 prompt，让 Agent 站在旧经验上开工。
 *
 * 三个刻意的设计决定：
 * 1. embedding 用本地 ONNX 多语言模型（paraphrase-multilingual-MiniLM，384 维），
 *    不走 API —— verify 要可复现，不能把测试成本和随机性绑在第三方接口上。
 * 2. 经验摘要不调 LLM，纯确定性规则生成 —— 记忆写入本身不应该再花钱、
 *    再引入不确定性，否则「记忆让结果变好」就没法归因了。
 * 3. 存储就是带向量的 JSON 文件 + 余弦相似度 —— 检索管线（向量化 → 打分 →
 *    top-k）和真实向量库完全一致，量大了把这一层换成 sqlite-vec / Qdrant
 *    不用动上游。
 *
 * 铁律：记忆模块任何失败都不能影响任务本身 —— 全部降级为「没有记忆」。
 */

export interface MemoryEntry {
  id: string;
  task: string;
  success: boolean;
  steps: number;
  /** 确定性摘要出的经验条目，注入 prompt 的就是这些行 */
  lessons: string[];
  /** task + lessons 的 embedding（已归一化，余弦相似度 = 点积） */
  vector: number[];
  createdAt: string;
}

const TOP_K = Number(process.env.MEMORY_TOP_K || 3);
const MIN_SCORE = Number(process.env.MEMORY_MIN_SCORE || 0.55);
const MAX_ENTRIES = Number(process.env.MEMORY_MAX_ENTRIES || 200);

/** 模型缓存放项目内，跟 node_modules 解耦：重装依赖不用重新下载 */
const MODEL_DIR = resolve(process.cwd(), ".models");
const DATA_DIR = process.env.MEMORY_DIR || resolve(process.cwd(), "data");
const MEMORY_FILE = join(DATA_DIR, "memory.json");

// ---------------------------------------------------------------------------
// embedding：本地 MiniLM，直连失败自动切 hf-mirror
// ---------------------------------------------------------------------------

type EmbedFn = (text: string) => Promise<number[]>;
let embedder: EmbedFn | null = null;
let embedderPromise: Promise<EmbedFn> | null = null;

async function loadEmbedder(): Promise<EmbedFn> {
  if (embedder) return embedder;
  if (embedderPromise) return embedderPromise;

  embedderPromise = (async () => {
    // env.remoteHost 必须在加载模型前设置；直连超时就切国内镜像
    const { pipeline, env } = await import("@huggingface/transformers");
    mkdirSync(MODEL_DIR, { recursive: true });
    env.cacheDir = MODEL_DIR;
    env.allowLocalModels = false;

    // 多语言模型：任务描述是中文，英文模型（all-MiniLM-L6-v2）在中文上
    // 语义区分度太差——改写任务相似度 0.45、无关任务也能到 0.5，没法设阈值。
    // paraphrase-multilingual 实测：改写任务 0.70~0.96，无关任务 ≤0.42。
    let pipe: Awaited<ReturnType<typeof pipeline>>;
    try {
      pipe = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    } catch {
      env.remoteHost = "https://hf-mirror.com";
      pipe = await pipeline("feature-extraction", "Xenova/paraphrase-multilingual-MiniLM-L12-v2");
    }

    embedder = async (text: string) => {
      const out = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(out.data as Float32Array);
    };
    return embedder;
  })();

  return embedderPromise;
}

/** 归一化向量的余弦相似度就是点积 */
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

function readStore(): MemoryEntry[] {
  try {
    if (!existsSync(MEMORY_FILE)) return [];
    const parsed = JSON.parse(readFileSync(MEMORY_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 文件坏了就当空库，别让一次写坏拖死所有后续任务
    return [];
  }
}

function writeStore(entries: MemoryEntry[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(MEMORY_FILE, JSON.stringify(entries, null, 2));
}

// ---------------------------------------------------------------------------
// 对外 API
// ---------------------------------------------------------------------------

export interface RecallHit {
  task: string;
  success: boolean;
  steps: number;
  lessons: string[];
  score: number;
}

/** 按任务语义检索相似的历史经验，返回 top-k（带相似度） */
export async function recall(task: string): Promise<RecallHit[]> {
  try {
    const entries = readStore();
    if (process.env.MEMORY_DEBUG) {
      console.error(`[memory:debug] file=${MEMORY_FILE} entries=${entries.length}`);
    }
    if (entries.length === 0) return [];
    const embed = await loadEmbedder();
    const query = await embed(task);
    const scored = entries
      .map((e) => ({ ...e, score: cosine(query, e.vector) }))
      .sort((a, b) => b.score - a.score);
    if (process.env.MEMORY_DEBUG) {
      console.error(`[memory:debug] top scores: ${scored.slice(0, 3).map((s) => s.score.toFixed(3)).join(", ")}`);
    }
    return scored
      .filter((e) => e.score >= MIN_SCORE)
      .slice(0, TOP_K)
      .map(({ task, success, steps, lessons, score }) => ({ task, success, steps, lessons, score }));
  } catch (err) {
    // 记忆召回任何问题都不该挡住任务，但要留痕，不然坏了都没人知道
    console.error("[memory] recall 失败（降级为无记忆）：", err);
    return [];
  }
}

/**
 * 把一次任务运行确定性摘要成经验并入库。
 * 摘要规则是纯规则不调 LLM —— 记忆写入不能引入新的成本和随机性。
 */
export async function store(input: {
  task: string;
  success: boolean;
  steps: number;
  /** 运行过程中收集的失败：工具报错或断言未通过 */
  failures: { tool: string; args: unknown; error?: string; pass?: boolean }[];
  /** 成功完成的交互（选择器已被验证有效） */
  actions: string[];
}): Promise<void> {
  try {
    const lessons = buildLessons(input);
    const embed = await loadEmbedder();
    // 检索键只取任务文本 —— 经验教训里混着英文选择器/数字，拼进 embedding
    // 会把任务语义稀释掉（实测同任务相似度从 0.92 掉到 0.46，直接跌破阈值）。
    // 教训是召回后的「内容」，不参与相似度计算。
    const vector = await embed(input.task);

    const entries = readStore();
    const id = createHash("sha1").update(input.task + Date.now()).digest("hex").slice(0, 12);
    entries.push({
      id,
      task: input.task,
      success: input.success,
      steps: input.steps,
      lessons,
      vector,
      createdAt: new Date().toISOString(),
    });

    // 超上限时丢最旧的，防止无限膨胀
    while (entries.length > MAX_ENTRIES) entries.shift();
    writeStore(entries);
  } catch {
    // 写入失败不影响任务结果
  }
}

/** 当前库里有多少条经验（展示用） */
export function count(): number {
  return readStore().length;
}

/** 清空记忆（verify 用例要对比冷/热启动） */
export function clear(): void {
  try {
    writeStore([]);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// 经验摘要：纯规则
// ---------------------------------------------------------------------------

function buildLessons(input: {
  task: string;
  success: boolean;
  steps: number;
  failures: { tool: string; args: unknown; error?: string; pass?: boolean }[];
  actions: string[];
}): string[] {
  const lessons: string[] = [];

  if (input.success) {
    // 把验证过有效的交互方式记下来，下次同类任务可以直接用
    for (const a of input.actions.slice(0, 6)) lessons.push(`有效交互：${a}`);
    lessons.push(`本次共 ${input.steps} 步完成，最终断言全部通过。`);
  } else {
    lessons.push(`任务未完成（${input.steps} 步），以下失败原因值得避免：`);
  }

  for (const f of input.failures.slice(0, 4)) {
    const what = f.error ?? (f.pass === false ? "断言未通过" : "调用失败");
    const detail = f.args ? JSON.stringify(f.args).slice(0, 80) : "";
    lessons.push(`失败教训：${f.tool}(${detail}) → ${what}`);
  }

  return lessons.slice(0, 10);
}
