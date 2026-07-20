import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

function writeFixture(root: string): void {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'src', 'entry.ts'),
    "import { startRun } from './execution';\nexport function dispatchTask(): number { return startRun(); }\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'execution.ts'),
    "import { spawnWorker } from './worker';\nexport function startRun(): number { return spawnWorker(); }\n",
  );
  fs.writeFileSync(
    path.join(root, 'src', 'worker.ts'),
    'export function spawnWorker(): number { return 1; }\n',
  );
  fs.writeFileSync(
    path.join(root, 'tests', 'execution.test.ts'),
    "import { startRun } from '../src/execution';\nexport function verifiesStartRun(): number { return startRun(); }\n",
  );
}

describe('CodeGraph.locate', () => {
  let tempDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-locate-'));
    writeFixture(tempDir);
    cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns ranked symbols, relationships, source snippets, and affected tests in one call', () => {
    const result = cg.locate({
      intent: 'Locate task dispatch',
      hints: ['startRun', 'spawnWorker', 'startRun'],
      maxCandidates: 4,
      maxSnippets: 2,
      maxSnippetLines: 20,
      depth: 2,
      includeTests: true,
    });

    expect(result.hints).toEqual(['startRun', 'spawnWorker']);
    expect(result.candidates.map((candidate) => candidate.name)).toContain('startRun');
    expect(result.candidates.map((candidate) => candidate.name)).toContain('spawnWorker');

    const startRun = result.candidates.find((candidate) => candidate.name === 'startRun');
    expect(startRun).toBeDefined();
    expect(startRun!.callers.map((node) => node.name)).toContain('dispatchTask');
    expect(startRun!.callees.map((node) => node.name)).toContain('spawnWorker');
    expect(startRun!.source?.text).toContain('export function startRun');
    expect(result.paths.some((flow) =>
      flow.steps[0]?.node.name === 'startRun' &&
      flow.steps.at(-1)?.node.name === 'spawnWorker',
    )).toBe(true);
    expect(result.affectedTests).toContain('tests/execution.test.ts');
    expect(result.unresolved).toEqual([]);
  });

  it('returns an explicit unresolved result when no hints match', () => {
    const result = cg.locate({
      intent: 'Locate a missing flow',
      hints: ['DefinitelyMissingSymbol'],
    });

    expect(result.candidates).toEqual([]);
    expect(result.confidence).toBe(0);
    expect(result.unresolved).toEqual(['No CodeGraph symbols matched the supplied hints']);
  });

  it('rejects an empty hint set', () => {
    expect(() => cg.locate({ intent: 'Locate task dispatch', hints: [' ', ''] })).toThrow(
      /non-empty code hint/i,
    );
  });
});
