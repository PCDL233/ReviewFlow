# LLM fixture 基准

该目录存放“模型输出 → 解析 → 行号校验 → 跨维归一”链路的录制 fixture。

- `*.json`：一次维度审查的模型输出（`findings` 数组），由 `scripts/record-llm-fixture.mjs` 用真实模型录制。
- 当前提交的 `security-eval.json` 来自本地 `ollama:qwen3.5:0.8b`，用于让 CI 有真实模型输出的契约回归；模型能力有限，不代表云端模型效果。
- 重新录制：`pnpm build && OLLAMA_MODEL=qwen3.5:0.8b node scripts/record-llm-fixture.mjs`（需启动 Ollama）。
- 云端模型录制：配置 `AI_REVIEW_CONFIG` 与 API Key，运行
  `AI_REVIEW_LIVE_EVAL=1 pnpm --filter @ai-review/core exec vitest run test/live-llm-eval.test.ts` 验证可检出后，
  用同一套 `scripts` 逻辑生成 fixture。

测试只断言 fixture 中的预期标题仍能通过校验/去重，不调用外部模型。
