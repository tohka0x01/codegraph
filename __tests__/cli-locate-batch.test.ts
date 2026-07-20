import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCli(
  args: string[],
  input?: string,
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        CODEGRAPH_NO_DAEMON: '1',
        CODEGRAPH_WASM_RELAUNCHED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', code: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      code: error.status ?? 1,
    };
  }
}

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

describe('native locate and batch CLI', () => {
  let tempDir: string;
  let startRunId: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-locate-'));
    writeFixture(tempDir);
    const cg = CodeGraph.initSync(tempDir);
    await cg.indexAll();
    startRunId = cg.getNodesByName('startRun')[0]!.id;
    cg.close();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('locate emits one structured report', () => {
    const result = runCli([
      'locate',
      'Task',
      'dispatch',
      '--hint',
      'startRun',
      '--hint',
      'spawnWorker',
      '--max-candidates',
      '3',
      '--json',
      '-p',
      tempDir,
    ]);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.candidates.map((candidate: { name: string }) => candidate.name)).toContain('startRun');
  });

  it('batch reads a bounded request from stdin and preserves operation order', () => {
    const request = JSON.stringify({
      operations: [
        { id: 'query', op: 'query', query: 'startRun' },
        { id: 'callers', op: 'callers', symbol: startRunId },
      ],
    });
    const result = runCli(['batch', '--stdin', '-p', tempDir], request);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results.map((entry: { id: string }) => entry.id)).toEqual(['query', 'callers']);
    expect(parsed.results[1].data.callers.map((node: { name: string }) => node.name)).toContain('dispatchTask');
  });

  it('existing relation commands accept a stable node ID', () => {
    const callers = runCli(['callers', startRunId, '--json', '-p', tempDir]);
    const callees = runCli(['callees', startRunId, '--json', '-p', tempDir]);
    const impact = runCli(['impact', startRunId, '--json', '-p', tempDir]);

    expect(callers.code).toBe(0);
    expect(callees.code).toBe(0);
    expect(impact.code).toBe(0);
    expect(JSON.parse(callers.stdout).callers.map((node: { name: string }) => node.name)).toContain('dispatchTask');
    expect(JSON.parse(callees.stdout).callees.map((node: { name: string }) => node.name)).toContain('spawnWorker');
    expect(JSON.parse(impact.stdout).affected.map((node: { name: string }) => node.name)).toContain('startRun');
  });

  it('JSON relation commands return an empty envelope for a missing symbol', () => {
    const result = runCli(['callers', 'DefinitelyMissingSymbol', '--json', '-p', tempDir]);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      symbol: 'DefinitelyMissingSymbol',
      callers: [],
    });
  });

  it('batch failures keep a structured JSON error contract', () => {
    const result = runCli(['batch', '--stdin', '-p', tempDir], '{"operations":[]}');

    expect(result.code).not.toBe(0);
    expect(JSON.parse(result.stderr)).toEqual({
      error: {
        code: 'BATCH_FAILED',
        message: 'batch request must contain at least one operation',
      },
    });
  });
});
