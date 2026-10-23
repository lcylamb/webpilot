# WebPilot

自然语言驱动的浏览器自动化 Agent 工作台。

用户输入一句自然语言任务（例如「打开待办页面，添加 3 条待办，并断言数量为 3」），Agent 自主规划步骤、调用 Playwright 操作浏览器、截图、断言、失败重试，最后生成报告。前端实时展示 Agent 的每一步思考、工具调用和结果。

> 个人开源项目：不依赖任何 Agent 框架，从 ReAct 执行循环到 MCP、RAG 记忆全部手写。

## 核心亮点

- **手写 ReAct 执行循环**：决策 → 工具调用 → 观察 → 再决策，不依赖任何 Agent 框架。
- **9 个浏览器工具**：`goto` / `getSnapshot` / `getAccessibilityTree` / `click` / `type` / `select` / `press` / `assertText` / `assertCount`，覆盖导航、观察、交互、断言。
- **MCP 工具生态**：同一套工具以 MCP Server 形式对外提供（`npm run mcp`，stdio 传输），任何 MCP 客户端可复用；Agent 又可作为 MCP Host 连接外部 MCP server，外部工具以 `mcp__<server>__<tool>` 并入工具箱、与内置工具平权（见下方「MCP 工具生态」）。
- **失败反思重试（Reflexion）**：断言未通过或工具报错时，注入反思消息要求模型先分析原因再换策略，禁止原样重试（上限 3 次）。
- **可访问性树 + 精简元素快照**：用 `getSnapshot` 给模型提供「元素 → 建议 CSS 选择器」的映射，比塞整段 DOM 省 token、定位更稳。
- **任务记忆（RAG）**：每次任务结束，把「成败 + 踩坑过程」确定性摘要成经验，用本地多语言 embedding 向量化入库；下次任务先按语义检索 top-k 历史经验注入 prompt。embedding 走本地 ONNX 模型，不走 API。
- **实时过程可视化**：NDJSON 流式推送每一步的工具名、参数、结果与页面截图，记忆的召回/写入也在界面上可见，把黑盒推理变成可调试的产品界面。
- **安全护栏**：最大步数、整体超时、域名白名单。
- **成本可观测**：报告页展示步数、耗时、prompt/completion token 数。

## 架构

```mermaid
flowchart TD
  U[用户: URL + 自然语言任务] --> F[Next.js 工作台]
  F -->|POST /api/agent NDJSON 流| A[ReAct 循环 lib/agent.ts]
  A -->|chat + tools| M[LLM DeepSeek / Qwen]
  A -->|executeTool| P[Playwright 无头浏览器]
  P --> W[目标网页]
  A -.开跑前.-> R["记忆召回 lib/memory.ts<br/>本地 embedding → 余弦相似度 → top-k"]
  R -.相似经验注入 prompt.-> A
  A -.跑完后.-> S[经验摘要入库 data/memory.json]
  G[护栏: 白名单 / 最大步数 / 超时] -.约束.-> A
```

```
lib/agent.ts       ReAct 循环 + 截图 + 护栏 + 记忆召回/写入的接入点
lib/llm.ts         OpenAI 兼容客户端（DeepSeek / Qwen）
lib/tools.ts       8 个工具的 schema + 执行器
lib/guardrails.ts  域名白名单
lib/memory.ts      任务记忆：本地 embedding + 向量存储 + top-k 检索（RAG）
```

## 快速开始

前置：Node.js 18+，网络可访问 DeepSeek（或 Qwen）。

```bash
# 1. 安装依赖
npm install

# 2. 下载 Chromium（Playwright 需要，约 100MB，只需一次）
npm run setup

# 3. 配置模型
cp .env.example .env.local
# 编辑 .env.local，填入 LLM_API_KEY（DeepSeek 或 Qwen）

# 4. 启动
npm run dev
```

打开 http://localhost:3000 ，点击「运行 Agent」即可看到默认演示（打开 `public/todo.html`，添加 3 条待办并断言）。

### Docker 一键启动（免装 Node / Chromium）

```bash
cp .env.example .env.local   # 填入 LLM_API_KEY
docker compose up --build    # 构建镜像（含 Chromium）并启动 → http://localhost:3000
```

镜像分三个阶段（deps → build → runtime）：构建期不需要任何密钥，LLM 配置全部通过
`env_file` 在运行时注入；运行期以非 root 用户跑，Playwright Chromium 及其系统依赖
在镜像内就位。

## 默认演示脚本

- URL：`http://localhost:3000/todo.html`（`public/todo.html`，一个内置的极简待办页）
- 任务：`打开这个待办事项页面，依次添加 3 条待办：买牛奶、写周报、预约体检。然后断言列表里恰好有 3 条待办。`

预期流程：Agent 先 `getSnapshot` 拿到 `#todo-input`、`#add-btn`、`.todo-item` 等选择器 → 逐条 `type` + `click` 添加 → `assertCount(".todo-item", 3)` 校验 → 输出最终总结。

## 可复现验证

Agent 有随机性，「跑一次成功」说明不了问题。`npm run verify` 会自己起一个静态服务器提供
`public/todo.html`（不需要先开着 `npm run dev`），跑固定用例，输出步数与 token 成本 ——
它回答的是「改了 prompt 之后，到底是变好还是变差」。

```bash
npm run verify              # 跑全部用例
npm run verify -- --only 2  # 只跑第 2 条
```

当前八条用例的实测结果（`deepseek-chat`，`temperature: 0`，2026-10-23）：

| 用例 | 步数 | 耗时 | prompt | completion | 断言 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 添加 3 条待办 → 断言数量为 3 | 10 | 8.8s | 14127 | 450 | 2/2 | 通过 |
| 添加 1 条指定内容 → 断言文本存在 | 6 | 5.6s | 7093 | 258 | 2/2 | 通过 |
| 什么都不加 → 断言数量为 0 | 4 | 2.9s | 4093 | 175 | 2/2 | 通过 |
| 记忆收益：同任务连跑两次，第二次命中经验 | 10 | 8.4s | 15360 | 455 | 2/2 | 通过 |
| 保险场景：理赔报案提交 → 断言已受理 | 10 | 5.5s | 9183 | 492 | 2/2 | 通过 |
| 保险场景：错误保单号被拦截 → 修正后重新提交 | 12 | 7.5s | 16269 | 665 | 2/2 | 通过 |
| 失败反思：错误预期 → 反思后换策略断言成功 | 6 | 5.7s | 7767 | 414 | 2/3 | 通过 |
| 门户场景：登录 → 查理赔进度 → 断言状态与金额 | 11 | 8.6s | 21099 | 562 | 3/3 | 通过 |

通过率 **8/8**，全量 98440 token。

## 保险场景（差异化）

`public/claim.html` 是一个模拟理赔报案表单（数据纯虚构）：保单号格式校验、日期格式校验、
下拉选择出险原因、金额校验，提交后受理并回显受理号和报案摘要。

选它做 Demo 场景的原因：这类重复性的表单录入 + 校验正是中后台业务里最繁琐的工作，
也是浏览器 Agent 最适合接管的事情。用例 5/6 覆盖了「一次填对」和「先被校验拦截、
读懂错误提示后修正重新提交」两条路径 —— 后者对 Agent 的要求高得多，
也是传统脚本自动化做不到的（脚本不会读错误提示）。

`public/portal.html` 是门户自动化场景：登录门（账号密码错误有明确提示）→
登录后进入 Tab 式工作区（报案 + 进度查询）。用例 8 走完整链路：
登录 → 断言当前用户 → 切换到进度查询 → 按受理号查单 → 断言状态与金额。
这是真实门户自动化的核心形态（登录之后的操作），也是纯脚本自动化
最脆弱的部分（登录态、Tab 切换、动态渲染的结果区）。

## 失败反思重试（Reflexion）

断言未通过或工具报错时，循环会注入一条反思消息：要求模型先分析失败原因、
换一种策略重试，严禁重复一模一样的调用（上限 3 次，防止反思循环烧步数）。

用例 7 验证这条路径：故意给一个错误预期（断言待办数量为 5，实际是 0），
实测 Agent 的恢复动作是——先 `getAccessibilityTree` 观察页面实际状态，
确认「选择器没错、是预期值错了」，然后用正确预期重新断言并通过。

判定上有个细节：这类用例的「第一次失败」是设计内的，不能用「有无失败断言」判死，
verify 对它单独判定——至少失败一次（证明走了失败路径）且最后一条断言通过（证明恢复了）。

## 任务记忆（RAG）

Agent 不是每次都从零开始。每次任务结束后，运行过程被**确定性摘要**成一条经验入库；
下次跑新任务前，先按任务语义检索相似经验注入 prompt。

三个刻意的设计决定：

1. **embedding 用本地 ONNX 模型（paraphrase-multilingual-MiniLM，384 维），不走 API。**
   verify 要可复现，不能把测试成本和随机性绑在第三方接口上；选多语言模型是因为
   任务描述是中文——英文模型在中文上语义区分度太差，改写任务相似度 0.45、
   无关任务也能到 0.5，阈值没法设；多语言模型实测改写任务 0.70~0.96、无关任务 ≤0.42。
2. **经验摘要不调 LLM，纯规则生成。** 记忆写入本身不该再花钱、再引入不确定性，
   否则「记忆让结果变好」就没法归因。
3. **检索键只用任务文本，教训只作为内容存取。** 踩过的坑：把教训拼进 embedding
   会稀释任务语义——实测同任务相似度从 0.92 掉到 0.46，直接跌破召回阈值。

存储层是 JSON 文件 + 余弦相似度，检索管线（向量化 → 打分 → top-k 过滤）和向量库
完全一致；量大了把这一层换成 sqlite-vec / Qdrant，上游不用动。记忆模块任何失败
都降级为「无记忆」，绝不影响任务本身。

判定标准是「模型声明 `STATUS: DONE` + 所有断言 pass」，不看模型自己的措辞有多自信。

用例加在 `scripts/verify.ts` 顶部的 `CASES` 数组里，一条就是一句任务描述。

> **这个脚本第一次跑就抓到两个真 bug**，记在这里是因为它们很典型：
>
> 1. **代码在循环外打开了页面，却没告诉模型。** 模型不知道自己在哪一页，就自己猜 URL
>    （先猜 `example.com`，再猜 `localhost:3000`），连撞三次白名单后直接放弃任务 —— 而它
>    上一次「跑通」纯属运气：那次它碰巧改用了 `getSnapshot` 去探页面。修法是在初始导航后
>    把「页面已打开 + 当前地址」作为一条消息压进 `messages`。
> 2. **`success` 判断错了。** 原来的条件是「模型不再调用工具了」，但模型放弃任务时同样
>    不再调用工具 —— 于是失败被报成「通过」。改成优先信模型声明的 `STATUS:` 行，没有
>    就退回「有没有失败断言」。

## MCP 工具生态

WebPilot 在 MCP 架构里有两个角色（协议：Model Context Protocol，stdio 传输）：

**1. MCP Server —— 工具协议化**（`mcp/server.ts`，`npm run mcp`）

把 9 个浏览器工具原样暴露为 MCP tools。工具执行复用 `lib/tools.ts` 的同一个 `executeTool` —— 协议层只是工具的另一种「壳」，业务逻辑零复制。任何 MCP 客户端（Claude Desktop、Inspector、其他 Agent）都能直接用：

```bash
npm run mcp                                            # 启动 stdio server
npx @modelcontextprotocol/inspector npm run mcp        # 调试面板
npm run mcp:e2e                                        # 离线自检：Host 连自己 → 列工具 → 导航 → 断言
```

**2. MCP Host —— 连接外部工具**（`lib/mcp.ts`）

Agent 循环启动时读取 `WEBPILOT_MCP_SERVERS`（JSON 数组），连接外部 MCP server 并把它们的工具并入工具箱：

```json
[{ "name": "browser", "command": "npx", "args": ["tsx", "mcp/server.ts"] }]
```

- 外部工具名加 `mcp__<server>__<tool>` 前缀，与内置工具（`goto`/`click`…）不冲突，模型也能一眼看出工具来源；
- MCP 的 `inputSchema` 与 function calling 的 `parameters` 同为 JSON Schema，直接透传；
- 连接/列举失败只告警并降级为「仅内置工具」，外部工具是增强不是依赖。

设计取舍：内置工具保持「函数直调」（低延迟、断言计数等循环逻辑强耦合），MCP 作为工具的**对外标准接口**与**扩展入口**——两者复用同一份执行器，不存在两套实现。

## 目录结构

```
webpilot/
├─ app/
│  ├─ api/agent/route.ts   # NDJSON 流式 API
│  ├─ layout.tsx
│  ├─ page.tsx             # 工作台 UI（任务输入 + 时间线 + 报告）
│  └─ globals.css
├─ lib/
│  ├─ agent.ts             # ReAct 循环 + 截图 + 护栏 + 记忆接入
│  ├─ llm.ts               # LLM 客户端
│  ├─ tools.ts             # 工具 schema + 执行器
│  ├─ guardrails.ts        # 域名白名单
│  └─ memory.ts            # 任务记忆（RAG）：本地 embedding + 向量检索
├─ mcp/server.ts           # MCP Server：9 个工具的 stdio 协议层
├─ public/todo.html        # 内置演示站点
├─ public/claim.html       # 模拟保险理赔报案页（数据纯虚构）
├─ public/portal.html      # 模拟保险门户：登录门 + 报案/进度查询 Tab 工作区
├─ python/agent_loop.py    # 同一 ReAct 循环的 Python 版（跨语言对照 + 自检）
├─ scripts/verify.ts       # 可复现验证（npm run verify，含记忆收益用例）
├─ scripts/mcp-e2e.ts      # MCP 端到端自检（不调 LLM）
├─ Dockerfile / compose.yaml
├─ .env.example
└─ package.json
```

## Python 版循环（跨语言对照）

`python/agent_loop.py` 是同一个 ReAct 循环的 Python 表达：与 TS 版逐段对应（SYSTEM_PROMPT / TOOLS / run_agent），用于证明 function calling 循环不绑定语言——核心就三件事：把工具 schema 发给模型、解析 `tool_calls`、把结果以 `role=tool` 压回历史。支持真实运行（playwright + DeepSeek）与 `--selftest`（假 LLM 驱动，离线验证消息流转与 Reflexion）。

```bash
python python/agent_loop.py --selftest   # 不联网验证循环机制
```

## 核心机制：function calling 循环是怎么跑的

1. **function calling 底层机制**：模型输出 `tool_calls`（含 `id` + `function.name` + JSON `arguments`）→ 你执行工具 → 把结果以 `{role:"tool", tool_call_id, content}` 压回 `messages` → 再问模型。循环直到模型不再输出 `tool_calls`。
2. **循环如何停止**：靠 `MAX_STEPS` 上限 + 模型主动选择不再调用工具（`tool_choice:"auto"` 时，模型认为完成会只回文本）。
3. **上下文/token 管理**：每轮把工具结果拼回历史，token 随步数增长；所以观察信号要精简（用 `getSnapshot` 的可访问性/选择器快照，而不是整段 DOM + 全尺寸截图）。
4. **稳定性**：工具参数用 JSON Schema 约束、`temperature:0`、失败重试、断言校验。
5. **安全护栏**：域名白名单防止被诱导访问未授权站点、最大步数防止无限烧 token。

## 部署说明

**不要用 Vercel 部署这个项目。** Playwright 需要无头 Chromium（几百 MB），Vercel 的 serverless 函数有体积上限和时长上限（免费版默认 10s），多步浏览器任务会超时/被砍。

正确做法：本地跑通即可演示；需要临时公网链接时用 ngrok / Cloudflare Tunnel。真到部署，用 Railway / Fly.io / Render / 便宜 VPS 这类能跑长时进程 + 大镜像的平台。

## 避坑

- 别一上来上 LangGraph / 多 Agent —— 先把手写循环吃透。
- 别做通用聊天套壳 —— 这个项目的差异点是「会动手操作 + 过程可视化」。
- 别爬未授权网站 —— 用内置的 `public/todo.html`、TodoMVC、自己的页面做测试。

## Roadmap

- 评估集扩容：`npm run verify` 目前 8 条，往 20+ 条扩，并加上重试率、幻觉率统计。
- 可观测：接 Langfuse 记录完整 trace。
- 任务队列：Redis + BullMQ 支撑并发任务。
- 存储升级：记忆量大后把 JSON 存储换成 sqlite-vec / Qdrant（检索管线不变）。
