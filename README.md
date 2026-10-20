# ReviewFlow

一个 Git 提交 AI 审查与风险分析系统。在开发者执行 `git commit` 时，系统自动读取暂存区变更，结合确定性静态分析与 LLM Agent，从正确性、安全性、性能和可维护性等维度生成结构化报告，并在代码进入仓库之前完成第一轮质量把关。

项目采用全栈 TypeScript 单语言实现（pnpm Monorepo + Turborepo）。`packages/shared` 中的 Zod schema 是配置、API 契约、数据库行类型和前端表单的单一事实源，尽量让契约漂移在编译期被发现。

## 功能总览

- **多 Agent 并行审查**：正确性 / 安全 / 性能三个维度经 LangGraph.js fan-out 并行审查，交叉验证抑制幻觉；低置信度 BLOCKER 支持自愈回退，最多 3 轮。`review.dimensions` 可关闭某一维度（关闭后不调用其 Agent，不产生 token 消耗）。
- **确定性优先**：密钥扫描（CWE-798/321）、圈复杂度和 AST 解析等工具先行，能由确定性工具判断的问题不重复交给 LLM。
- **多语言上下文提取**：JS/TS 使用 ts-morph，Python/Go/Java 使用 Tree-sitter 官方语法包，按函数边界裁剪上下文；解析失败时降级为行级窗口，不阻塞流水线。
- **用户自定义审查规则**：管理员可在后台定义正则规则（名称/严重度/文件过滤/匹配范围），在 static 阶段以确定性工具 `custom_rule_check` 执行，支持在线试跑；保存后下一次审查即生效（服务端热重读配置，无需重启）。
- **风险规划分流**：按 0–100 风险评分选择深度审查、快速审查或仅静态分析；全流程有 token 硬预算与文件数/变更行数上限，超限文件降级为静态分析并在报告中标注。
- **审查缓存**：按 agent、prompt 版本和代码内容计算哈希，相同代码块可跨审查复用发现，避免重复消耗 LLM。
- **RAG 知识库**：按 AST/文档边界切块，使用 LanceDB 向量检索与 MiniSearch BM25，经 RRF 融合后注入审查上下文；索引按块级内容哈希增量更新。
- **fast / full 双模式**：`fast` 用于 pre-commit，目标耗时 ≤15 秒；`full` 用于 CI 和手动深度审查，目标耗时 ≤60 秒。
- **四种审查范围**：暂存区、工作区、单个提交、提交区间——全部可在 Web 上选择，报告记录 commit 与作者以便追溯。
- **Web Dashboard**：登录后查看审查历史、五段式报告、diff、行级发现、误报标记、SSE 实时进度和 ECharts 统计分析；配置、规则、知识库、Hook 安装全部在页面内完成。
- **团队权限管理**：首个注册用户自动成为管理员；管理员可以查看全量审查数据、管理用户、编辑配置、维护知识库并查看 Prometheus 指标。
- **Hook / CI 一体化**：管理后台一键把 pre-commit hook 写入仓库，也签发 CI 令牌；两者调用同一个同步审查端点，共用 0/1/2/3 退出码契约。
- **MCP 工具开放**：静态分析工具经 `/api/mcp`（Streamable HTTP，默认关闭）暴露，可供 Claude Code 等外部 Agent 复用。
- **可观测性**：提供 `/metrics` Prometheus 指标、`/api/stats` 统计聚合接口，以及登录/操作审计日志（后台页面查询 + 控制台输出 + 按日归档文件）。

## 系统架构

```text
┌─────────────────────────────────────────────────────────────────┐
│ 交互层：Web Dashboard (React 19)  │  Git Hook  │  CI           │
│         API Server (Hono 4, REST + SSE + 静态托管)               │
├─────────────────────────────────────────────────────────────────┤
│ Agent 编排层：LangGraph.js StateGraph                            │
│   parse → riskPlan → [correctness│security│performance] (并行)   │
│         → validate → (heal 自愈回退) → report                    │
├─────────────────────────────────────────────────────────────────┤
│ 分析引擎层：LLM Agent (AI SDK 5) │ 静态分析 (ts-morph/Tree-sitter)│
│             RAG (LanceDB + MiniSearch) │ 工具总线 (进程内 + MCP)  │
├─────────────────────────────────────────────────────────────────┤
│ 数据层：SQLite/Drizzle (users/sessions/reviews/findings/cache)   │
│         LanceDB 向量索引 │ 报告文件 │ Prometheus 指标              │
└─────────────────────────────────────────────────────────────────┘
```

一次审查的业务链路：

1. 触发：Web 页面发起、`git commit` 触发 `.husky/pre-commit`，或 CI 调用 `POST /api/hooks/review`。
2. Git Reader 按所选范围读取 diff（暂存区 / 工作区 / 单个提交 / 区间），而不是无条件读取工作区；diff 按文件和函数边界构建上下文。
3. 风险规划器按文件评分，选择深度审查、快速审查或仅静态分析；随后施加 token 预算与规模上限。
4. 配置启用的审查维度 Agent 并行执行，并受 token 预算和取消信号约束。
5. 交叉验证阶段重分类严重度、计算置信度、去重并排序；低置信度 BLOCKER 进入自愈重审（受预算约束）。
6. 生成 Markdown、HTML 或 JSON 报告，记录 commit 与作者，按 `blockOn` 阈值判定是否阻断。
7. 结果写入 SQLite，审查缓存复用已有发现，Dashboard 通过 SSE 接收进度；Hook/CI 拿到退出码决定是否放行。

模式差异：

| 环节             | `fast`（pre-commit 默认） | `full`（CI / 手动）            |
| ---------------- | ------------------------- | ------------------------------ |
| 目标             | 尽快反馈，不拖慢提交      | 更完整的上下文和审查覆盖       |
| 风险较低文件     | 优先静态分析              | 仍可进入 LLM 审查              |
| RAG / 历史上下文 | 按配置使用，控制上下文    | 按配置使用，允许更充分的上下文 |
| 适用场景         | 本地提交前门禁            | PR、发布前或手动专项审查       |

## 技术栈

| 层次       | 技术                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| 运行时     | Node.js ≥22、TypeScript 6、ESM                                                            |
| Monorepo   | pnpm 10.24.0、Turborepo                                                                   |
| Agent 编排 | LangGraph.js、AI SDK 5                                                                    |
| 模型       | Anthropic、OpenAI、国内主流（DeepSeek/智谱/Moonshot/通义千问/豆包/MiniMax）、Ollama、mock |
| 静态分析   | ts-morph、Tree-sitter、确定性 secret/complexity 工具                                      |
| RAG        | LanceDB、MiniSearch、RRF                                                                  |
| 服务端     | Hono 4、REST、SSE、Prometheus                                                             |
| 数据库     | Drizzle ORM、better-sqlite3、SQLite                                                       |
| 前端       | React 19、Vite 8、TanStack Router/Query、Ant Design 6、ECharts                            |
| 部署       | Docker multi-stage、`node:22-alpine`                                                      |

第三方依赖版本集中声明在 `pnpm-workspace.yaml` 的 `catalog`，各 workspace 包使用 `catalog:` 引用。

## Monorepo 结构

```text
apps/
  server/    @ai-review/server  —— Hono API、SSE、/metrics、静态文件托管
  web/       @ai-review/web     —— React 19 Dashboard（Vite + Ant Design + ECharts）
packages/
  shared/    配置、API、Finding、审查来源、退出码等 Zod schema 单一事实源
  diff/      unified diff、index/分支/提交内容读取、上下文提取
  core/      LangGraph 流水线、风险规划、交叉验证、审查缓存接口
  agents/    ReAct 审查 Agent
  tools/     静态分析工具总线与 MCP Server
  rag/       LanceDB + MiniSearch RAG 索引与检索
  llm/       Provider 封装、mock/录制回放、token 预算器
  db/        Drizzle ORM + SQLite（用户、会话、审查、缓存和 Hook 令牌）
  report/    Markdown / HTML / JSON 报告渲染

tooling/
  eslint-config/ —— 全仓 ESLint 配置
  tsconfig/      —— 共享 TypeScript 配置
```

## 快速开始

### 1. 安装依赖

前置要求：Node.js `>=22`。根 `package.json` 固定使用 pnpm `10.24.0`，推荐通过 Corepack 激活：

```bash
corepack enable
pnpm install
pnpm build
```

如果只需要执行测试或检查，也可以使用：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

### 2. 初始化配置

配置文件由管理后台生成，无需终端操作：登录后进入 **管理后台 → 配置初始化** 点击「生成默认配置」，
系统会依据 `AiReviewConfigSchema` 写出 `.ai-review.yml`；随后在 **系统配置 / AI 模型** 页面直接编辑。
密钥字段支持 `${ENV_NAME}` 引用，请不要把明文 API Key 提交到 Git。

最小的云端模型配置示例（仍通过环境变量提供密钥）：

```bash
# PowerShell
$env:AI_REVIEW_API_KEY = "your-api-key"

# bash/zsh
export AI_REVIEW_API_KEY="your-api-key"
```

默认 provider 是 `anthropic`。也可以把 `llm.provider` 改为 `openai`、`deepseek`、`zhipu`、`moonshot`、`dashscope`、`volcengine`、`minimax`、`ollama` 或 `mock`。其中 `mock` 不访问网络，适合离线验证流水线和运行确定性测试。

### 3. 本地运行 Dashboard

开发环境使用 `pnpm dev` 同时启动 API Server 和 Vite：

```bash
pnpm dev
```

- Web Dashboard：<http://localhost:5173>
- API Server：<http://localhost:8080>
- 开发期 Vite 将 `/api` 代理到 `http://localhost:8080`。
- `pnpm dev` 会按 Turbo 依赖图先构建所需 workspace；如果手动直接运行 `apps/server`，请先执行 `pnpm build` 生成 `dist`。

### 4. 执行第一次审查

1. 打开 **发起审查** 页面。
2. 从仓库下拉中选择工作区（或直接粘贴绝对路径）。选中后会显示当前分支、HEAD 提交、暂存/未暂存/未跟踪文件数。
3. 选择审查范围：
   - **暂存区**：提交前把关的标准范围（默认）。
   - **工作区**：HEAD 与磁盘的差异，含未暂存改动。
   - **单个提交**：回溯或补充审查某次已提交的变更。
   - **提交区间**：`base...HEAD`，用于合并前检查。
4. 选择审查模式（fast / full）与阻断阈值，点击「开始审查」，进度通过 SSE 实时刷新。
5. 完成后点击「查看完整报告」。### 5. 安装 Git Hook（一次点击）

1. 先确保目标仓库已启用 husky v9（`core.hooksPath`）：在仓库内执行一次 `pnpm exec husky init`。
2. 进入 **管理后台 → Git Hook 与 CI**，选择仓库，点击「安装到此仓库」。
3. 服务端会写入两个文件并签发令牌：

| 文件 | 作用 |
| --- | --- |
| `.husky/pre-commit` | husky 入口，调用 Node 运行器 |
| `.ai-review/hooks/pre-commit.mjs` | 真正发起审查、按退出码放行/阻断 |
| `.ai-review-cache/hook-token` | 调用令牌（不进入版本库） |
| `.gitignore` | 自动补齐 `.ai-review-cache/`、`.ai-review/`，防止令牌被 `git add -A` 提交 |

之后每次 `git commit` 都会自动审查暂存区：发现达到阻断阈值的 Finding 时退出码为 1，阻止提交；服务不可达时退出码为 3，不阻断。

### 6. 首次启动团队版

构建前端后由服务端同端口托管 API 与 Dashboard：

```bash
pnpm build
node apps/server/dist/main.js --port 8080 --db .ai-review-cache/reviews.db --web-dist apps/web/dist
```

首次打开 <http://localhost:8080> 时注册第一个账号。第一个注册账号自动获得 `admin` 角色，建议部署后立即完成注册并安全保存凭据；项目不提供固定的默认管理员密码。之后注册的账号默认是普通用户。

## 使用指南（全部在 Web 完成）

项目不提供命令行入口。所有能力都在 Dashboard 与 HTTP API 上：

| 需求 | 入口 |
| --- | --- |
| 发起审查（四种范围） | 用户端「发起审查」 |
| 查看历史 / 报告 / diff / 误报标记 | 「审查历史」→ 报告详情 |
| 统计与趋势 | 「统计分析」 |
| 生成 /.ai-review.yml | 后台「配置初始化」 |
| 编辑模型、审查、静态分析、知识库、日志、服务端参数 | 后台「系统配置」「AI 模型」 |
| 维护自定义审查规则（含试跑） | 后台「自定义规则」 |
| 重建 RAG 索引 | 后台「知识库」 |
| 在线试跑密钥扫描与复杂度检查 | 后台「分析工具」 |
| 安装 Git Hook / 管理 CI 令牌 | 后台「Git Hook 与 CI」 |
| 用户、角色、日志、指标 | 后台对应用户/角色/日志/指标页 |

### 审查 API（供 Hook、CI 与脚本使用）

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /api/reviews` | 会话 Cookie | 异步发起审查，返回 `202` + `reviewId`；进度走 SSE |
| `GET /api/reviews/:id/events` | 会话 Cookie | 实时进度（SSE） |
| `POST /api/hooks/review` | `Authorization: Bearer <token>` | **同步**审查，响应携带 `exitCode`，供 Hook / CI 判定 |
| `GET /api/repos` | 会话 Cookie | 仓库发现（扫描允许根目录 + 历史审查记录） |
| `GET /api/repos/{status,branches,commits}` | 会话 Cookie | 仓库工作区状态、分支、提交列表 |
| `POST /api/mcp` | Bearer 令牌 | MCP over Streamable HTTP（需在系统配置中开启） |

`POST /api/reviews` 与 `POST /api/hooks/review` 的请求体：

```json
{
  "repoPath": "D:/work/project",
  "target": "range",
  "base": "origin/main",
  "mode": "full",
  "blockOn": "BLOCKER"
}
```

`target` 取值与必填参数：

| target | 必填 | 含义 |
| --- | --- | --- |
| `staged`（默认） | — | index 与 HEAD 的差异 |
| `worktree` | — | HEAD 与工作区磁盘的差异 |
| `commit` | `commit` | 单个提交相对其父提交的差异 |
| `range` | `base`（`head` 可选，默认 HEAD） | `base...head` 区间 |

引用（分支 / SHA / 相对引用）会经过白名单校验：以 `-` 开头的值一律拒绝，避免 git 参数注入。

Hook / CI 响应的稳定退出码（`exitCode` 字段，调用方脚本据此决定是否放行）：

| 退出码 | 含义 |
| --- | --- |
| `0` | 没有发现达到阻断阈值的 Finding |
| `1` | 存在达到 `blockOn` 级别的发现，阻断提交或 CI 步骤 |
| `2` | 配置或环境错误，例如配置校验失败、Git 仓库无效或参数缺失 |
| `3` | 审查超时或被取消；默认不作为缺陷阻断提交 |

### 知识库索引

索引重建在后台「知识库」页触发，无需命令行：

- 索引按下述配置的路径递归扫描并跳过常见生成目录：`rag.knowledgeBasePaths`。
- 嵌入模型由 `AI_REVIEW_EMBEDDING_MODEL` 指定（默认本地 Ollama `nomic-embed-text`），端点由 `AI_REVIEW_EMBEDDING_BASE_URL` 指定（默认 `http://127.0.0.1:11434/v1`）。
- 索引按块级内容哈希增量更新，重复重建不会重复处理未变化内容；重建期间审查跳过知识库检索。
- 修改知识库路径后需要重新重建索引，旧索引不会自动迁移。

### 服务端启动参数

#### 服务端环境变量

> 以下参数除 `AI_REVIEW_API_KEY` 外均可在管理后台「系统配置 → 服务端」页面配置（写入配置文件的 `server` 段）。
> 生效优先级：环境变量 > 配置文件 server 段 > 默认值——部署层显式设置的环境变量仍可覆盖 web 保存的值；
> 服务启动时读取一次，保存后需重启服务生效。

| 变量                         | 默认值       | 说明                                                                                                  |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `AI_REVIEW_ALLOWED_ROOTS`    | `cwd`        | 允许发起审查的仓库根目录白名单，多个用路径分隔符分隔（Windows `;` / POSIX `:`）；越界路径一律 400     |
| `AI_REVIEW_MAX_CONCURRENT`   | `3`          | 并行审查任务上限（信号量排队，防压垮 LLM 配额）                                                       |
| `AI_REVIEW_COOKIE_SECURE`    | 关           | `true` 时强制会话 Cookie 携带 `Secure`（NODE_ENV=production 下自动开启）                               |
| `AI_REVIEW_ALLOW_REGISTER`   | 关           | `true` 时放开开放注册；缺省仅在无任何用户时允许（首个管理员引导后自动关闭）                            |
| `AI_REVIEW_TRUST_PROXY`      | 关           | 反向代理（nginx 等）部署时开启：限流改用 `X-Forwarded-For` 末值识别真实客户端 IP，避免全员共享代理 IP 的限流桶 |
| `AI_REVIEW_OLLAMA_MODEL`     | `qwen3-coder:30b` | Ollama 回退模型（云端 provider 不可用时的本地兜底）                                          |
| `AI_REVIEW_API_KEY`          | 无           | 模型 API Key，配合配置文件的 `${AI_REVIEW_API_KEY}` 引用；切勿写入仓库（仅可通过环境变量提供）        |

Docker 镜像默认 `NODE_ENV=production`，会话 Cookie 自动启用 `Secure`；若在 http 反向代理后部署，请同时设置 `AI_REVIEW_COOKIE_SECURE=false` 并配合 `AI_REVIEW_TRUST_PROXY=true`。

### MCP 对外开放工具

静态分析工具经 MCP over Streamable HTTP 暴露，端点为 `POST /api/mcp`。
需先在「系统配置 → 服务端」打开「启用 MCP 端点」，并使用后台签发的 Bearer 令牌。

```json
{
  "mcpServers": {
    "ai-review-tools": {
      "type": "http",
      "url": "http://localhost:8080/api/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

当前工具：

| 工具               | 入参                      | 输出                                  |
| ------------------ | ------------------------- | ------------------------------------- |
| `complexity_check` | `file_path`、`threshold?` | 超过阈值的函数名称、行号和复杂度      |
| `secret_scan`      | `diff_text`               | 疑似密钥/凭证、严重度、CWE 和修复建议 |

## 配置文件（`.ai-review.yml`）

所有字段都可以省略，省略时使用 schema 默认值。`loadConfig` 会递归解析 `${ENV_NAME}`，配置校验失败会给出字段级错误（管理后台保存时即返回校验错误；Hook/CI 路径返回退出码 `2`）。
发起审查时若未显式选择审查模式/阻断阈值，将回退使用 `review.mode`/`review.blockOn` 配置值；重新执行（rerun）沿用原审查发起时的范围、模式与阈值。示例：

```yaml
llm:
  provider: anthropic # anthropic | openai | deepseek | zhipu | moonshot | dashscope | volcengine | minimax | ollama | mock
  model: claude-sonnet-5
  apiKey: ${AI_REVIEW_API_KEY}
  maxTokensPerReview: 50000
  temperature: 0.1
  mockFixturesDir: .ai-review-cache/llm-fixtures

review:
  mode: fast # fast | full
  dimensions: [correctness, security, performance, maintainability]
  blockOn: BLOCKER # BLOCKER | WARNING | NIT
  ignorePatterns: ['*.lock', 'pnpm-lock.yaml', 'dist/**', '*.min.js']
  maxFiles: 200 # 单次审查纳入的文件数上限；超限按风险分降序截断并在报告中标注
  maxChangedLines: 20000 # 单次审查纳入的变更行数上限（additions + deletions）

rag:
  enabled: true
  knowledgeBasePaths: ['docs/']
  indexDir: .ai-review-cache/vectors
  topK: 5

staticAnalysis:
  enabledTools: [ast_parse, complexity_check, secret_scan, dependency_scan, custom_rule_check]
  complexityThreshold: 15

# 审计日志（登录日志 + 操作日志）：SQLite 落库供后台查询，同时输出控制台并按日滚动归档；
# 保存后需重启服务生效（基础设施配置，不随审查热重读）
logging:
  enabled: true   # 总开关：关闭后不再写入新日志（存量日志仍可查询）
  console: true   # 输出到控制台（单行可读格式）
  file: true      # 写文件归档（JSON Lines，按日滚动）
  dir: logs       # 日志目录：<dir>/ai-review-login-YYYY-MM-DD.log 与 -operation- 同名
  maxDays: 30     # 超过保留天数的旧日志文件自动清理

# 用户自定义审查规则（管理员在后台维护，随配置生效；匹配范围：added 新增行 / staged 文件全文 / snippet 函数片段）
# 保存后下一次审查立即生效（服务端热重读，无需重启）；存在启用规则时 custom_rule_check 自动参与，无需在 enabledTools 单独开启。
# pattern 为正则源码（≤1024 字符），非法表达式在保存/试跑时即被拒绝；规则在审查路径逐行执行，请避免灾难性回溯的正则。
customRules:
  - name: no-todo
    description: 禁止提交遗留的 TODO/FIXME 标记
    pattern: '\b(TODO|FIXME)\b'
    flags: i
    severity: WARNING
    message: 检测到遗留的 TODO 标记
    suggestion: 清理注释或创建跟踪任务后删除
    filePatterns: ['src/**']
    matchScope: [added]
    enabled: true

# 服务端运行参数（原 AI_REVIEW_* 环境变量，现可在管理后台「服务端」卡片配置）：
# 生效优先级：环境变量 > 此处配置 > 默认值（部署层环境变量仍可覆盖 web 保存的值）。
# 属基础设施配置，服务启动时读取一次，保存后需重启服务生效。
server:
  allowedRoots: []           # 允许发起审查的仓库根目录白名单；空 = 仅当前工作目录
  maxConcurrent: 3           # 并行审查任务上限（信号量排队）
  cookieSecure: false        # 强制会话 Cookie Secure（NODE_ENV=production 下自动开启）
  allowRegister: false       # 放开开放注册（缺省仅在无任何用户时允许首账号引导）
  trustProxy: false          # 反向代理部署时信任 X-Forwarded-For 识别真实 IP
  ollamaModel: qwen3-coder:30b  # Ollama 回退模型（云端不可用时的本地兜底）
  hookTimeoutMs: 120000      # Hook/CI 同步审查超时；超时返回退出码 3（不阻断）
  mcpEnabled: false          # 是否暴露 /api/mcp（MCP over Streamable HTTP）

report:
  format: markdown # markdown | html | json（导出默认格式）
  outputDir: .ai-review-reports
  includePraise: true # 是否在报告中保留 PRAISE 级发现
```

LLM Provider 端点：

| Provider  | 默认端点                                            | 可选环境变量                    |
| --------- | --------------------------------------------------- | ------------------------------- |
| Anthropic | `https://api.anthropic.com/v1`                      | `AI_REVIEW_ANTHROPIC_BASE_URL`  |
| OpenAI    | `https://api.openai.com/v1`                         | `AI_REVIEW_OPENAI_BASE_URL`     |
| DeepSeek  | `https://api.deepseek.com/v1`                       | `AI_REVIEW_DEEPSEEK_BASE_URL`   |
| 智谱 GLM  | `https://open.bigmodel.cn/api/paas/v4`              | `AI_REVIEW_ZHIPU_BASE_URL`      |
| Moonshot  | `https://api.moonshot.cn/v1`                        | `AI_REVIEW_MOONSHOT_BASE_URL`   |
| 通义千问  | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `AI_REVIEW_DASHSCOPE_BASE_URL`  |
| 豆包      | `https://ark.cn-beijing.volces.com/api/v3`          | `AI_REVIEW_VOLCENGINE_BASE_URL` |
| MiniMax   | `https://api.minimax.chat/v1`                       | `AI_REVIEW_MINIMAX_BASE_URL`    |
| Ollama    | `http://127.0.0.1:11434/v1`                         | `AI_REVIEW_OLLAMA_BASE_URL`     |

Ollama 的默认模型回退为 `qwen3-coder:30b`，可用 `AI_REVIEW_OLLAMA_MODEL` 覆盖。云端 provider 未配置真实 Key 时，系统会尝试本地 Ollama；若仍不可用，则保留确定性静态分析和 mock fallback。生产环境仍应显式配置可用的模型服务。

严重度分级：`BLOCKER`（阻断级缺陷）/ `WARNING`（应修复）/ `NIT`（建议）/ `PRAISE`（正面反馈）。

## 认证与权限

服务端使用 SQLite 保存用户和会话，登录态通过 HttpOnly Cookie `ai_review_session` 传递，默认有效期为 7 天。SSE 使用同一 Cookie 认证，因此浏览器 Dashboard 无需额外维护 Authorization Header。

- `/api/auth/register` 和 `/api/auth/login` 可匿名访问，其余 `/api` 接口默认要求登录。
- 首个注册用户自动成为 `admin`；后续注册用户为 `user`。
- 普通用户只能查看、重新执行、取消、导出和删除自己发起的审查，并只能修改自己审查中的误报标记。
- 管理员可以查看全量审查数据、修改用户角色和状态、重置密码、删除其他用户、编辑项目配置、重建 RAG 知识库、查看系统指标与登录/操作审计日志。
- 管理员不能通过后台删除自己或将自己降级/禁用，避免锁死最后的管理入口。
- 后台重置密码会生成一次性随机密码并立即吊销目标用户的旧会话；请通过安全渠道交付新密码。

首次部署建议：

1. 先限制服务访问范围或放在可信网络内。
2. 使用浏览器注册第一个管理员账号，并立即保存账号信息。
3. 在管理后台配置模型、审查规则和知识库路径。
4. 根据团队需要注册普通用户，再由管理员分配角色或禁用账号。

项目不提供默认管理员用户名或默认密码，也不会在日志或 API 响应中返回密码哈希。

## Web Dashboard

开发环境访问 <http://localhost:5173>，生产环境访问服务端托管地址 <http://localhost:8080>。页面按登录状态和角色分为两组：

### 用户端

1. **登录 / 注册**：建立 7 天 HttpOnly Cookie 会话。
2. **审查工作区**：发起审查、查看运行状态和取消任务。
3. **审查历史**：按状态和分页查看当前用户可见的审查记录。
4. **报告详情**：查看五段式报告、完整 diff、行级 Findings，支持标记误报、重新执行和导出；导出菜单提供
   Markdown / HTML / JSON 下载，以及「复制 Markdown」与「打印 / 另存为 PDF」。
5. **统计分析**：查看审查数量、发现数量、误报数量、平均风险分、平均耗时、Token 消耗、按日趋势、严重度分布和 Top 高风险文件。
6. **个人资料**：查看当前账号并修改密码；修改密码会吊销旧会话。

### 管理后台（仅 admin）

1. **系统概览**：查看用户数、管理员数、审查数、发现数、Token 消耗、缓存摘要和最近失败记录。
2. **用户管理**：查看用户列表，修改角色/状态，重置密码或删除其他用户。
3. **配置管理**：读取并保存 `.ai-review.yml`；API Key 在页面中以 `********` 掩码显示，提交掩码值会保留原密钥；「服务端」卡片可配置原环境变量参数（仓库白名单/并发上限/安全开关等，保存后重启生效），并只读展示运行环境（端口、DB 路径、前端静态目录）。
4. **自定义规则**：查看、新增、编辑、删除和启停自定义审查规则，并可粘贴示例 diff / 源码在线试跑验证正则命中。
5. **知识库管理**：查看索引状态并异步触发 RAG 增量重建。
6. **Git Hook 与 CI**：选择仓库一键安装 pre-commit hook（服务端写盘）、管理 Bearer 令牌、查看脚本内容与 CI 示例。
7. **静态分析工具**：在线粘贴 diff / 源码试跑密钥扫描与复杂度检查。
8. **登录日志 / 操作日志**：分页查看认证事件与管理/审查写操作审计，支持日期范围、状态、动作与关键词筛选（仅持有对应权限的账号可见）。

## HTTP API

所有非 `/api/auth/*`、`/api/hooks/*`、`/api/mcp` 的 `/api` 路由都需要有效登录会话；管理员路由额外需要对应页面权限（RBAC）。`/api/hooks/*` 与 `/api/mcp` 使用 `Authorization: Bearer <hook token>`。除特别说明外，响应形状由 `@ai-review/shared` 的 Zod schema 定义。

### 认证

| 路由                        | 方法 | 说明                                     |
| --------------------------- | ---- | ---------------------------------------- |
| `/api/auth/register`        | POST | 注册；首个用户自动成为 admin，并建立会话 |
| `/api/auth/login`           | POST | 登录并建立 Cookie 会话                   |
| `/api/auth/logout`          | POST | 登出并清理当前会话                       |
| `/api/auth/me`              | GET  | 获取当前登录用户                         |
| `/api/auth/change-password` | POST | 修改当前用户密码并吊销旧会话             |

### 审查与统计

| 路由                                                  | 方法   | 说明                                                 |
| ----------------------------------------------------- | ------ | ---------------------------------------------------- |
| `/api/reviews`                                        | POST   | 发起审查，返回 `202 + { reviewId }`；`target/base/commit` 定义审查范围，`mode`/`blockOn` 未传时回退系统配置 |
| `/api/reviews`                                        | GET    | 审查历史列表；普通用户仅返回本人记录，支持查询和分页 |
| `/api/reviews/:id`                                    | GET    | 五段式报告详情与行级 findings                        |
| `/api/reviews/:id/diff`                               | GET    | 获取审查使用的 diff                                  |
| `/api/reviews/:id/events`                             | GET    | 审查进度 SSE                                         |
| `/api/reviews/:id/rerun`                              | POST   | 重新执行可访问的审查，返回 `202 + { reviewId }`      |
| `/api/reviews/:id/cancel`                             | POST   | 取消正在运行的审查                                   |
| `/api/reviews/:id/export?format=markdown\|html\|json` | GET    | 导出报告；未指定 `format` 时使用 `report.format`      |
| `/api/reviews/:id`                                    | DELETE | 删除可访问的审查记录                                 |
| `/api/findings/:id`                                   | PATCH  | 更新误报标记，请求体 `{ "isFalsePositive": true }`   |
| `/api/stats`                                          | GET    | 统计聚合；普通用户仅统计本人数据                     |

### 管理与运维（仅 admin）

| 路由                                  | 方法   | 说明                                          |
| ------------------------------------- | ------ | --------------------------------------------- |
| `/api/admin/overview`                 | GET    | 系统概览、缓存摘要和最近失败记录              |
| `/api/admin/users`                    | GET    | 用户列表                                      |
| `/api/admin/users/:id`                | PATCH  | 修改用户角色或 active/disabled 状态           |
| `/api/admin/users/:id/reset-password` | POST   | 重置密码并返回新随机密码；旧会话立即失效      |
| `/api/admin/users/:id`                | DELETE | 删除其他用户及其会话                          |
| `/api/admin/config`                   | GET    | 读取已掩码的项目配置                          |
| `/api/admin/config`                   | PUT    | 更新项目配置；`apiKey: "********"` 保留原密钥 |
| `/api/admin/knowledge`                | GET    | 查看知识库索引状态                            |
| `/api/admin/knowledge/reindex`        | POST   | 异步接受知识库增量重建任务，返回 `202`        |
| `/api/admin/rules`                    | GET    | 自定义审查规则列表                            |
| `/api/admin/rules`                    | PUT    | 整体保存自定义审查规则（随配置持久化）        |
| `/api/admin/rules/test`               | POST   | 试跑规则：`{ rule, sampleDiffText?, sampleSource? }` 返回命中行 |
| `/api/admin/login-logs`               | GET    | 登录日志（分页 + 日期/状态/动作/用户名筛选；权限 `/admin/login-logs`） |
| `/api/admin/operation-logs`           | GET    | 操作日志（分页 + 日期/状态/动作/资源筛选；权限 `/admin/operation-logs`） |
| `/api/admin/hooks/tokens`             | GET    | Hook / CI 令牌列表（不含明文；权限 `/admin/hook`） |
| `/api/admin/hooks/tokens`             | POST   | 签发令牌，返回一次明文 `{ token, plainText }` |
| `/api/admin/hooks/tokens/:id`         | DELETE | 吊销令牌 |
| `/api/admin/hooks/script`             | GET    | 获取 hook 脚本内容（`shell` + `runner` 及相对路径） |
| `/api/admin/hooks/install`            | POST   | 在仓库内写盘安装 hook 并落令牌文件 |
| `/api/mcp`                            | POST   | MCP over Streamable HTTP（需 `server.mcpEnabled` + Bearer 令牌） |
| `/metrics`                            | GET    | Prometheus 文本格式指标                       |

### Hook / CI（Bearer 令牌）

| 路由                  | 方法 | 说明 |
| --------------------- | ---- | ---- |
| `/api/hooks/review`   | POST | 同步执行一次审查，响应含 `exitCode`（0/1/2/3）；超时返回 3 且不阻断 |

### 仓库发现

| 路由                       | 方法 | 说明 |
| -------------------------- | ---- | ---- |
| `/api/repos`               | GET  | 允许根目录扫描结果 + 历史审查仓库 |
| `/api/repos/status`        | GET  | 分支、HEAD、暂存/未暂存/未跟踪计数 |
| `/api/repos/branches`      | GET  | 本地分支列表（按最近提交排序） |
| `/api/repos/commits`       | GET  | 提交列表（`ref` 指定起点，默认 HEAD） |

SSE 事件通过 `event` + JSON `data` 发送：

| event        | 主要字段                                            | 说明                                                                                                        |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `subscribed` | `reviewId`                                          | 客户端订阅成功                                                                                              |
| `stage`      | `reviewId`, `stage`                                 | 流水线阶段开始：parse / riskPlan / correctness / security / performance / static / validate / heal / report |
| `completed`  | `reviewId`, `riskScore`, `blockerCount`, `blocking` | 审查完成；`blocking` 与 Hook/CI 退出码 1 语义一致                                                           |
| `failed`     | `reviewId`, `message`                               | 审查失败                                                                                                    |
| `cancelled`  | `reviewId`                                          | 审查被取消                                                                                                  |

## Prometheus 指标

`/metrics` 仅管理员可读，输出 Prometheus 文本格式：

| 指标                                | 类型      | 标签                       | 说明                          |
| ----------------------------------- | --------- | -------------------------- | ----------------------------- |
| `ai_review_reviews_total`           | Counter   | `status=completed\|failed` | 审查终态计数                  |
| `ai_review_findings_total`          | Counter   | `severity`                 | 按严重度统计发现              |
| `ai_review_tokens_used_total`       | Counter   | —                          | LLM token 累计消耗            |
| `ai_review_review_duration_seconds` | Histogram | —                          | 端到端审查耗时                |
| 默认进程指标                        | —         | —                          | CPU、GC、事件循环等运行时指标 |

## 审查缓存与 RAG 索引

- **审查缓存**：键包含 agent、prompt 版本和代码内容，与仓库路径无关；相同代码块可以跨审查、跨仓库复用。prompt 或输出契约变化时递增 `REVIEW_PROMPT_VERSION`，缓存自动失效。
- **RAG 索引**：默认持久化到 `.ai-review-cache/vectors`，知识库路径由 `rag.knowledgeBasePaths` 指定。在后台「知识库」重建后只重新向量化新增或变化的块。
- **运行时降级**：索引或模型服务不可用不会改变确定性静态分析的职责；报告会保留可用结果并标注受限阶段。

## 基准测试与测试策略

`packages/core/test/benchmark.test.ts` 内置 CWE 锚定语料（CWE-798 硬编码凭证、CWE-321 私钥块、CWE-657 复杂度超标），度量静态分析层的 recall / precision / F1，作为回归门禁。当前基线为 recall `1.0`、precision `0.8`、F1 约 `0.89`；唯一已知误报是占位符凭据。

LLM 集成测试使用 `packages/llm` 的录制/回放 Provider：首次真实调用将响应保存为 fixture，后续测试直接回放，保证确定性并避免重复消耗 token。

## Docker 部署

项目提供单容器部署方式：API、Dashboard 和 SQLite 审查库一起运行。

```bash
docker compose up --build
```

启动后访问 <http://localhost:8080>。Compose 会把 `.ai-review-cache` 挂载到名为 `review-data` 的 volume，因此 SQLite、审查缓存和向量索引不会因容器重建而丢失。

实现细节：

- build 阶段使用 `corepack pnpm install --frozen-lockfile` 和 `pnpm turbo build --filter=@ai-review/server... --filter=@ai-review/web...`。
- 运行阶段基于 `node:22-alpine`，并复制 server/web 与 workspace 包的构建产物。
- `better-sqlite3` 没有可用预编译包时，构建阶段会使用预装的 `python3`、`make`、`g++` 编译。
- Compose 当前不自动注入模型 API Key；需要通过配置文件、环境变量或管理后台配置可用的 provider。
- PostgreSQL / Redis 不是当前单容器部署的必需依赖，属于团队版多机部署扩展方向。

## CI/CD 集成

- `.github/workflows/ci.yml`：push / PR 执行 lint、typecheck、build 和 test 全量门禁。
- `.github/workflows/ai-review.yml`：PR 触发后启动服务并用 `POST /api/hooks/review`（`target: range`、`base: origin/<base>`、`mode: full`）执行同步审查，把风险评分、BLOCKER 数与退出码回帖到 PR。
- 审查发现达到阻断阈值时响应 `exitCode` 为 1；工作流应把该结果作为审查结论处理，而不是误判为基础设施故障。`exitCode` 为 3 表示超时，工作流不应阻断。

## 开发指南

```bash
pnpm dev         # Turbo 并行启动 server 与 web
pnpm build       # 按依赖图构建所有 workspace
pnpm lint        # ESLint flat config
pnpm typecheck   # Turbo typecheck
pnpm test        # Turbo test
pnpm format      # Prettier --write（会修改文件）
```

代码约定（详见[代码编写规范](docs/代码编写规范.md)）：

- 依赖版本只声明在 `pnpm-workspace.yaml` 的 `catalog`，包内以 `catalog:` 引用。
- 禁止 `any`、`as` 断言和 `@ts-ignore`；导出函数显式声明返回类型；类型从 Zod schema 推导。
- 提交信息遵循 Conventional Commits：`<type>(<scope>): <subject>`，scope 使用包短名。
- 新增 Turbo 任务或 workspace 包时同步更新任务依赖图与文档。

## 故障排查

| 现象                                    | 处理方式                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Cannot find .../dist` 或服务启动即退出 | 先运行 `pnpm build`；`pnpm dev` 会自动按 Turbo 依赖图构建，但直接运行 server 不会                           |
| 8080/5173 已被占用                      | 启动服务时用 `--port <port>` 修改 API 端口；开发期同步调整 `apps/web/vite.config.ts` 的代理目标            |
| `better-sqlite3` 安装失败               | 使用 Node.js 22，并重新执行 `pnpm install`；Linux/alpine 构建需有 `python3`、`make`、`g++`                  |
| 云端 provider 报 API Key 错误           | 确认 `AI_REVIEW_API_KEY` 已导出，且 `.ai-review.yml` 使用 `${AI_REVIEW_API_KEY}`；不要把 Key 写进仓库       |
| 选择 Ollama 但连接失败                  | 启动 Ollama，确认默认 `http://127.0.0.1:11434/v1` 可访问，并准备模型；也可设置 `AI_REVIEW_OLLAMA_BASE_URL`  |
| 知识库重建失败                          | 确认 embedding 服务可用、`rag.knowledgeBasePaths` 不为空，并检查 `AI_REVIEW_EMBEDDING_BASE_URL` 与模型是否匹配 |
| Hook 提交时报「未找到令牌」             | 在后台「Git Hook 与 CI」重新安装；确认 `.ai-review-cache/hook-token` 存在且未被清理                        |
| Dashboard 请求 401/403                  | 先登录；普通用户不能访问 `/api/admin/*` 或 `/metrics`，被禁用用户需要管理员恢复状态                         |
| 前端打开但 API 请求失败                 | 开发环境确认 server 在 8080；生产环境使用 `--web-dist apps/web/dist`，不要把 Vite 开发代理配置当作生产代理  |
| Docker 重建后数据看似丢失               | 确认使用 `docker compose up`，不要删除 `review-data` volume；检查 `/app/.ai-review-cache` 挂载状态          |
