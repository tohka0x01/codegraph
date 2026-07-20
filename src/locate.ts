import * as fs from 'fs';
import * as path from 'path';
import type CodeGraph from './index';
import type { Edge, Node, NodeKind, SearchResult } from './types';
import { isGeneratedFile } from './extraction/generated-detection';
import { matchesSymbol, summarizeNode, type SymbolLocation } from './symbol-resolution';

const MAX_INPUT_LENGTH = 10_000;
const MAX_HINTS = 16;
const DEFAULTS = Object.freeze({
  maxCandidates: 6,
  depth: 2,
  maxSnippetLines: 60,
  maxSnippets: 4,
  maxRelated: 20,
  maxTests: 30,
  maxPaths: 8,
  includeTests: true,
});
const LIMITS = Object.freeze({
  maxCandidates: [1, 20] as const,
  depth: [1, 5] as const,
  maxSnippetLines: [1, 200] as const,
  maxSnippets: [0, 10] as const,
  maxRelated: [1, 100] as const,
  maxTests: [1, 100] as const,
  maxPaths: [0, 20] as const,
});
const KIND_WEIGHT: Partial<Record<NodeKind, number>> = Object.freeze({
  method: 50,
  function: 50,
  component: 45,
  class: 30,
  struct: 30,
  interface: 20,
  trait: 20,
  protocol: 20,
  route: 20,
  type_alias: 10,
  file: -20,
  import: -50,
  export: -50,
});
const FLOW_EDGE_KINDS: Edge['kind'][] = [
  'calls',
  'references',
  'instantiates',
  'overrides',
  'implements',
];
const TEST_FILE_PATTERNS = [
  /\.spec\./,
  /\.test\./,
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)e2e\//,
  /(^|\/)spec\//,
];

export interface LocateRequest {
  intent: string;
  hints: string[];
  maxCandidates?: number;
  depth?: number;
  maxSnippetLines?: number;
  maxSnippets?: number;
  maxRelated?: number;
  maxTests?: number;
  maxPaths?: number;
  includeTests?: boolean;
}

export interface LocatedSource {
  startLine: number;
  endLine: number;
  declaredEndLine: number;
  truncated: boolean;
  text: string;
}

export interface LocateCandidate extends SymbolLocation {
  matchedHints: string[];
  score: number;
  callers: SymbolLocation[];
  callees: SymbolLocation[];
  affected: SymbolLocation[];
  source: LocatedSource | null;
  sourceError?: string;
}

export interface LocatePathStep {
  node: SymbolLocation;
  via: {
    kind: string;
    line?: number;
    column?: number;
  } | null;
}

export interface LocatePath {
  from: string;
  to: string;
  steps: LocatePathStep[];
}

export interface LocateResult {
  intent: string;
  hints: string[];
  confidence: number;
  candidates: LocateCandidate[];
  paths: LocatePath[];
  affectedTests: string[];
  affectedTestsTruncated: boolean;
  unresolved: string[];
  metrics: {
    queryCount: number;
    candidateCount: number;
    relationCount: number;
    pathCount: number;
  };
}

interface NormalizedLocateRequest {
  intent: string;
  hints: string[];
  maxCandidates: number;
  depth: number;
  maxSnippetLines: number;
  maxSnippets: number;
  maxRelated: number;
  maxTests: number;
  maxPaths: number;
  includeTests: boolean;
}

interface CandidateAggregate {
  node: Node;
  matchedHints: Set<string>;
  bestScore: number;
  exactMatches: number;
}

/**
 * Build a bounded location report in one database session.
 * Safe for concurrent calls on independent CodeGraph instances; callers must
 * serialize access when sharing one instance across threads.
 */
export function locateCode(cg: CodeGraph, request: LocateRequest): LocateResult {
  const normalized = normalizeRequest(request);
  const discovered = discoverCandidates(cg, normalized);
  if (discovered.length === 0) {
    return emptyResult(normalized);
  }

  const candidates = discovered.map((candidate, index) =>
    expandCandidate(cg, candidate, { request: normalized, index }),
  );
  const paths = findCandidatePaths(cg, candidates, normalized.maxPaths);
  const testResult = normalized.includeTests
    ? findAffectedTests(cg, candidates, normalized)
    : { tests: [], truncated: false };
  const relationCount = candidates.reduce(
    (total, candidate) => total + candidate.callers.length + candidate.callees.length + candidate.affected.length,
    0,
  );

  return {
    intent: normalized.intent,
    hints: normalized.hints,
    confidence: confidenceFor(candidates[0]!),
    candidates,
    paths,
    affectedTests: testResult.tests,
    affectedTestsTruncated: testResult.truncated,
    unresolved: [],
    metrics: {
      queryCount: normalized.hints.length,
      candidateCount: candidates.length,
      relationCount,
      pathCount: paths.length,
    },
  };
}

function normalizeRequest(request: LocateRequest): NormalizedLocateRequest {
  if (!request || typeof request !== 'object') {
    throw new Error('locate request is required');
  }
  const hints = normalizeHints(request.hints);
  if (hints.length === 0) {
    throw new Error('at least one non-empty code hint is required');
  }
  const includeTests = request.includeTests ?? DEFAULTS.includeTests;
  if (typeof includeTests !== 'boolean') {
    throw new Error('includeTests must be a boolean');
  }
  return {
    intent: requireText(request.intent, 'intent'),
    hints,
    maxCandidates: bounded(request.maxCandidates, 'maxCandidates'),
    depth: bounded(request.depth, 'depth'),
    maxSnippetLines: bounded(request.maxSnippetLines, 'maxSnippetLines'),
    maxSnippets: bounded(request.maxSnippets, 'maxSnippets'),
    maxRelated: bounded(request.maxRelated, 'maxRelated'),
    maxTests: bounded(request.maxTests, 'maxTests'),
    maxPaths: bounded(request.maxPaths, 'maxPaths'),
    includeTests,
  };
}

function normalizeHints(value: string[]): string[] {
  if (!Array.isArray(value) || value.some((hint) => typeof hint !== 'string')) {
    throw new Error('hints must be a string array');
  }
  const hints = [...new Set(value.map((hint) => hint.trim()).filter(Boolean))];
  if (hints.length > MAX_HINTS) {
    throw new Error(`hints may contain at most ${MAX_HINTS} entries`);
  }
  if (hints.some((hint) => hint.length > MAX_INPUT_LENGTH)) {
    throw new Error(`each hint may contain at most ${MAX_INPUT_LENGTH} characters`);
  }
  return hints;
}

function discoverCandidates(cg: CodeGraph, request: NormalizedLocateRequest): CandidateAggregate[] {
  const candidates = new Map<string, CandidateAggregate>();
  const queryLimit = Math.min(request.maxCandidates * 3, 50);
  for (const hint of request.hints) {
    const results = withExactMatches(cg, hint, cg.searchNodes(hint, { limit: queryLimit }));
    for (const result of results) {
      mergeCandidate(candidates, result, hint);
    }
  }
  return [...candidates.values()]
    .sort(compareCandidates)
    .slice(0, request.maxCandidates);
}

function withExactMatches(cg: CodeGraph, hint: string, results: SearchResult[]): SearchResult[] {
  const merged = new Map(results.map((result) => [result.node.id, result]));
  const byId = cg.getNode(hint);
  const exact = byId
    ? [byId]
    : cg.getNodesByName(lastQualifierPart(hint)).filter((node) => matchesSymbol(node, hint));
  for (const node of exact) {
    const current = merged.get(node.id);
    merged.set(node.id, { node, score: Math.max(current?.score ?? 0, 1_000) });
  }
  return [...merged.values()];
}

function mergeCandidate(
  candidates: Map<string, CandidateAggregate>,
  result: SearchResult,
  hint: string,
): void {
  const current = candidates.get(result.node.id);
  if (current) {
    current.matchedHints.add(hint);
    current.bestScore = Math.max(current.bestScore, result.score);
    current.exactMatches += matchesSymbol(result.node, hint) ? 1 : 0;
    return;
  }
  candidates.set(result.node.id, {
    node: result.node,
    matchedHints: new Set([hint]),
    bestScore: result.score,
    exactMatches: matchesSymbol(result.node, hint) ? 1 : 0,
  });
}

function compareCandidates(left: CandidateAggregate, right: CandidateAggregate): number {
  if (left.matchedHints.size !== right.matchedHints.size) {
    return right.matchedHints.size - left.matchedHints.size;
  }
  const scoreDifference = candidateScore(right) - candidateScore(left);
  if (scoreDifference !== 0) {
    return scoreDifference;
  }
  const generatedDifference = Number(isGeneratedFile(left.node.filePath)) - Number(isGeneratedFile(right.node.filePath));
  if (generatedDifference !== 0) {
    return generatedDifference;
  }
  return left.node.qualifiedName.localeCompare(right.node.qualifiedName);
}

function candidateScore(candidate: CandidateAggregate): number {
  return candidate.bestScore
    + candidate.matchedHints.size * 50
    + candidate.exactMatches * 100
    + (KIND_WEIGHT[candidate.node.kind] ?? 0)
    - (isTestFile(candidate.node.filePath) ? 100 : 0);
}

function expandCandidate(
  cg: CodeGraph,
  candidate: CandidateAggregate,
  context: { request: NormalizedLocateRequest; index: number },
): LocateCandidate {
  const { request, index } = context;
  const callers = uniqueLocations(
    cg.getCallers(candidate.node.id).map((entry) => entry.node),
    request.maxRelated,
  );
  const callees = uniqueLocations(
    cg.getCallees(candidate.node.id).map((entry) => entry.node),
    request.maxRelated,
  );
  const affected = uniqueLocations(
    [...cg.getImpactRadius(candidate.node.id, request.depth).nodes.values()],
    request.maxRelated,
  );
  const sourceResult = index < request.maxSnippets
    ? readSource(cg.getProjectRoot(), candidate.node, request.maxSnippetLines)
    : { source: null };
  const result: LocateCandidate = {
    ...summarizeNode(candidate.node),
    matchedHints: [...candidate.matchedHints].sort(),
    score: candidateScore(candidate),
    callers,
    callees,
    affected,
    source: sourceResult.source,
  };
  if (sourceResult.error) {
    result.sourceError = sourceResult.error;
  }
  return result;
}

function uniqueLocations(nodes: Node[], limit: number): SymbolLocation[] {
  const seen = new Set<string>();
  const results: SymbolLocation[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    results.push(summarizeNode(node));
    if (results.length >= limit) {
      return results;
    }
  }
  return results;
}

function readSource(
  projectRoot: string,
  node: Node,
  maxLines: number,
): { source: LocatedSource | null; error?: string } {
  const absolute = safeSourcePath(projectRoot, node.filePath);
  try {
    const content = fs.readFileSync(absolute, 'utf8');
    return { source: extractSnippet(content, node, maxLines) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source: null, error: message };
  }
}

function safeSourcePath(projectRoot: string, filePath: string): string {
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, filePath);
  const child = path.relative(root, absolute);
  if (!child.startsWith('..') && !path.isAbsolute(child)) {
    return absolute;
  }
  throw new Error(`${filePath} resolves outside the project`);
}

function extractSnippet(content: string, node: Node, maxLines: number): LocatedSource {
  const lines = content.split(/\r?\n/);
  if (node.startLine > lines.length) {
    throw new Error(`${node.filePath}:${node.startLine} exceeds the file length`);
  }
  const endLine = Math.min(node.endLine, node.startLine + maxLines - 1, lines.length);
  const text = lines
    .slice(node.startLine - 1, endLine)
    .map((line, index) => `${node.startLine + index}\t${line}`)
    .join('\n');
  return {
    startLine: node.startLine,
    endLine,
    declaredEndLine: node.endLine,
    truncated: endLine < node.endLine,
    text,
  };
}

function findCandidatePaths(
  cg: CodeGraph,
  candidates: LocateCandidate[],
  maxPaths: number,
): LocatePath[] {
  const paths: LocatePath[] = [];
  const seen = new Set<string>();
  const pairs = candidates.flatMap((from) =>
    candidates
      .filter((to) => to.id !== from.id)
      .map((to) => ({ from, to })),
  );
  const attempts = pairs.slice(0, maxPaths * 4);
  for (const pair of attempts) {
    const found = cg.findPath(pair.from.id, pair.to.id, FLOW_EDGE_KINDS);
    if (!found || found.length < 2) continue;
    const key = found.map((entry) => entry.node.id).join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    paths.push({
      from: pair.from.id,
      to: pair.to.id,
      steps: found.map((entry) => {
        const via = entry.edge
          ? {
              kind: entry.edge.kind,
              ...(entry.edge.line !== undefined ? { line: entry.edge.line } : {}),
              ...(entry.edge.column !== undefined ? { column: entry.edge.column } : {}),
            }
          : null;
        return { node: summarizeNode(entry.node), via };
      }),
    });
    if (paths.length >= maxPaths) return paths;
  }
  return paths;
}

function findAffectedTests(
  cg: CodeGraph,
  candidates: LocateCandidate[],
  request: NormalizedLocateRequest,
): { tests: string[]; truncated: boolean } {
  const tests = new Set<string>();
  const visited = new Set<string>();
  const queue = [...new Set(candidates.map((candidate) => candidate.filePath))]
    .map((filePath) => ({ filePath, depth: 0 }));
  for (const item of queue) {
    visited.add(item.filePath);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (isTestFile(current.filePath)) {
      tests.add(current.filePath);
      continue;
    }
    if (current.depth >= request.depth) {
      continue;
    }
    const next = collectNewDependents(
      cg.getFileDependents(current.filePath),
      { visited, tests, depth: current.depth + 1 },
    );
    queue.push(...next);
  }

  const ordered = [...tests].sort();
  return {
    tests: ordered.slice(0, request.maxTests),
    truncated: ordered.length > request.maxTests,
  };
}

function collectNewDependents(
  dependents: string[],
  state: { visited: Set<string>; tests: Set<string>; depth: number },
): Array<{ filePath: string; depth: number }> {
  const queued: Array<{ filePath: string; depth: number }> = [];
  for (const dependent of dependents) {
    if (state.visited.has(dependent)) continue;
    state.visited.add(dependent);
    if (isTestFile(dependent)) {
      state.tests.add(dependent);
      continue;
    }
    queued.push({ filePath: dependent, depth: state.depth });
  }
  return queued;
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function confidenceFor(candidate: LocateCandidate): number {
  const evidence = candidate.matchedHints.length
    + Number(candidate.callers.length > 0)
    + Number(candidate.callees.length > 0);
  return Math.min(1, Number((0.35 + evidence * 0.15).toFixed(2)));
}

function emptyResult(request: NormalizedLocateRequest): LocateResult {
  return {
    intent: request.intent,
    hints: request.hints,
    confidence: 0,
    candidates: [],
    paths: [],
    affectedTests: [],
    affectedTestsTruncated: false,
    unresolved: ['No CodeGraph symbols matched the supplied hints'],
    metrics: {
      queryCount: request.hints.length,
      candidateCount: 0,
      relationCount: 0,
      pathCount: 0,
    },
  };
}

type LimitName = keyof typeof LIMITS;

function bounded(
  value: number | undefined,
  name: LimitName,
): number {
  const resolved = value ?? DEFAULTS[name];
  const [minimum, maximum] = LIMITS[name];
  if (Number.isInteger(resolved) && resolved >= minimum && resolved <= maximum) {
    return resolved;
  }
  throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
}

function requireText(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > MAX_INPUT_LENGTH) {
    throw new Error(`${name} may contain at most ${MAX_INPUT_LENGTH} characters`);
  }
  return result;
}

function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter(Boolean);
  return parts[parts.length - 1] ?? symbol;
}
