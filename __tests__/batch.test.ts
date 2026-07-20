import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'flow.ts'),
    [
      'export function dispatchTask(): number { return startRun(); }',
      'export function startRun(): number { return spawnWorker(); }',
      'export function spawnWorker(): number { return 1; }',
      '',
    ].join('\n'),
  );
}

describe('CodeGraph.executeBatch', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-batch-'));
    writeFixture(tempDir);
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('executes ordered query, relation, impact, and locate operations against one graph', () => {
    const startRunId = cg.getNodesByName('startRun')[0]!.id;
    const result = cg.executeBatch({
      operations: [
        { id: 'search', op: 'query', query: 'startRun', limit: 5 },
        { id: 'callers-by-id', op: 'callers', symbol: startRunId, limit: 10 },
        { id: 'callees', op: 'callees', symbol: 'startRun', limit: 10 },
        { id: 'impact', op: 'impact', symbol: 'startRun', depth: 2 },
        {
          id: 'locate',
          op: 'locate',
          intent: 'Locate task dispatch',
          hints: ['startRun', 'spawnWorker'],
          maxCandidates: 3,
          includeTests: false,
        },
      ],
    });

    expect(result.results.map((entry) => entry.id)).toEqual([
      'search',
      'callers-by-id',
      'callees',
      'impact',
      'locate',
    ]);
    expect(result.results.every((entry) => entry.ok)).toBe(true);

    const callers = result.results[1]!.data as { callers: Array<{ name: string }> };
    expect(callers.callers.map((node) => node.name)).toContain('dispatchTask');

    const callees = result.results[2]!.data as { callees: Array<{ name: string }> };
    expect(callees.callees.map((node) => node.name)).toContain('spawnWorker');

    const locate = result.results[4]!.data as { candidates: Array<{ name: string }> };
    expect(locate.candidates.map((node) => node.name)).toContain('startRun');
  });

  it('rejects an unbounded operation list before executing it', () => {
    const operations = Array.from({ length: 51 }, (_, index) => ({
      id: `query-${index}`,
      op: 'query' as const,
      query: 'startRun',
    }));

    expect(() => cg.executeBatch({ operations })).toThrow(/at most 50 operations/i);
  });
});
