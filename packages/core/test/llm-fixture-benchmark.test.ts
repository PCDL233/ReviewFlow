import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateFindings } from '@ai-review/agents';
import { FindingSchema } from '@ai-review/shared';
import type { CodeContext, Finding } from '@ai-review/shared';
import type { ReviewDimension } from '@ai-review/llm';
import { describe, expect, it } from 'vitest';
import { crossValidate } from '../src/index.js';

/** fixture 基准：录制/回放模型输出，断言解析、行号校验、跨维归一后的召回。 */

const CONTENT = 'eval(userInput);';
const context: CodeContext = {
  files: [
    {
      diff: {
        path: 'src/live-eval.ts',
        oldPath: null,
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
        removedLines: [],
        changedLines: [{ type: 'added', oldLineNo: null, newLineNo: 1, content: CONTENT }],
        summary: CONTENT,
      },
      stagedContent: CONTENT,
      snippet: CONTENT,
      signature: null,
      ragHits: [],
      changeType: 'feature',
    },
  ],
  metadata: {
    totalFiles: 1,
    totalAdditions: 1,
    totalDeletions: 0,
    languages: ['typescript'],
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
};

type Fixture = {
  id: string;
  dimension: ReviewDimension;
  expectedTitles: string[];
  findings: Finding[];
};

function readFixtures(): Fixture[] {
  const dir = fileURLToPath(new URL('./fixtures/llm/', import.meta.url));
  const fixtures: Fixture[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (typeof raw !== 'object' || raw === null) continue;
    if (!('id' in raw) || typeof raw.id !== 'string') continue;
    if (!('dimension' in raw) || raw.dimension !== 'security') continue;
    if (!('findings' in raw)) continue;
    const parsed = FindingSchema.array().safeParse(raw.findings);
    if (!parsed.success) continue;
    const expectedTitles =
      'expectedTitles' in raw &&
      Array.isArray(raw.expectedTitles) &&
      raw.expectedTitles.every((title) => typeof title === 'string')
        ? raw.expectedTitles
        : parsed.data.map((finding) => finding.title);
    fixtures.push({
      id: raw.id,
      dimension: 'security',
      expectedTitles,
      findings: parsed.data,
    });
  }
  return fixtures;
}

describe('LLM fixture benchmark', () => {
  const fixtures = readFixtures();
  it.skipIf(fixtures.length === 0)('keeps recorded findings after validation and dedupe', () => {
    for (const fixture of fixtures) {
      const validated = validateFindings(fixture.findings, context, fixture.dimension).findings;
      const merged = crossValidate(validated, context);
      const titles = new Set(merged.map((finding) => finding.title));
      for (const expected of fixture.expectedTitles) {
        expect(titles.has(expected), `${fixture.id} lost: ${expected}`).toBe(true);
      }
    }
  });
});
