import type CodeGraph from './index';
import { NODE_KINDS, type NodeKind, type Subgraph } from './types';
import { locateCode, type LocateRequest } from './locate';
import { resolveSymbolNodes, summarizeNode, type SymbolLocation } from './symbol-resolution';

const MAX_INPUT_LENGTH = 10_000;
const NODE_KIND_SET = new Set<string>(NODE_KINDS);

interface BatchOperationBase {
  id?: string;
}

export interface BatchQueryOperation extends BatchOperationBase {
  op: 'query';
  query: string;
  limit?: number;
  kind?: NodeKind;
}

export interface BatchRelationOperation extends BatchOperationBase {
  op: 'callers' | 'callees';
  symbol: string;
  limit?: number;
}

export interface BatchImpactOperation extends BatchOperationBase {
  op: 'impact';
  symbol: string;
  depth?: number;
  limit?: number;
}

export interface BatchNodeOperation extends BatchOperationBase {
  op: 'node';
  symbol: string;
  limit?: number;
}

export interface BatchLocateOperation extends BatchOperationBase, LocateRequest {
  op: 'locate';
}

export type BatchOperation =
  | BatchQueryOperation
  | BatchRelationOperation
  | BatchImpactOperation
  | BatchNodeOperation
  | BatchLocateOperation;

export interface BatchRequest {
  operations: BatchOperation[];
}

export interface BatchOperationResult {
  id: string;
  index: number;
  op: BatchOperation['op'];
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface BatchResult {
  results: BatchOperationResult[];
}

/**
 * Execute bounded read-only operations while reusing one open graph.
 * Safe for concurrent calls on independent CodeGraph instances; callers must
 * serialize access when sharing one instance across threads.
 */
export function executeBatch(cg: CodeGraph, request: BatchRequest): BatchResult {
  const operations = validateRequest(request);
  return {
    results: operations.map((operation, index) => executeEntry(cg, operation, index)),
  };
}

function validateRequest(request: BatchRequest): BatchOperation[] {
  if (!request || typeof request !== 'object' || !Array.isArray(request.operations)) {
    throw new Error('batch request must contain an operations array');
  }
  if (request.operations.length === 0) {
    throw new Error('batch request must contain at least one operation');
  }
  if (request.operations.length > 50) {
    throw new Error('batch request may contain at most 50 operations');
  }
  const ids = new Set<string>();
  for (const operation of request.operations) {
    validateOperation(operation);
    if (!operation.id) {
      continue;
    }
    if (ids.has(operation.id)) {
      throw new Error(`batch operation id "${operation.id}" is duplicated`);
    }
    ids.add(operation.id);
  }
  return request.operations;
}

function validateOperation(operation: BatchOperation): void {
  if (!operation || typeof operation !== 'object') {
    throw new Error('batch operation must be an object');
  }
  if (operation.id !== undefined) {
    requireText(operation.id, 'operation.id');
  }
  switch (operation.op) {
    case 'query':
      requireText(operation.query, 'query');
      optionalBound(operation.limit, 'limit', [1, 200]);
      if (operation.kind !== undefined && !NODE_KIND_SET.has(operation.kind)) {
        throw new Error(`unsupported node kind: ${operation.kind}`);
      }
      return;
    case 'callers':
    case 'callees':
    case 'node':
      requireText(operation.symbol, 'symbol');
      optionalBound(operation.limit, 'limit', [1, 200]);
      return;
    case 'impact':
      requireText(operation.symbol, 'symbol');
      optionalBound(operation.depth, 'depth', [1, 10]);
      optionalBound(operation.limit, 'limit', [1, 500]);
      return;
    case 'locate':
      requireText(operation.intent, 'intent');
      if (!Array.isArray(operation.hints)) {
        throw new Error('locate hints must be an array');
      }
      return;
    default:
      throw new Error(`unsupported batch operation: ${String((operation as { op?: unknown }).op)}`);
  }
}

function executeEntry(
  cg: CodeGraph,
  operation: BatchOperation,
  index: number,
): BatchOperationResult {
  const id = operation.id ?? `${operation.op}-${index}`;
  try {
    return {
      id,
      index,
      op: operation.op,
      ok: true,
      data: executeOperation(cg, operation),
    };
  } catch (error) {
    return {
      id,
      index,
      op: operation.op,
      ok: false,
      error: {
        code: 'OPERATION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function executeOperation(cg: CodeGraph, operation: BatchOperation): unknown {
  switch (operation.op) {
    case 'query':
      return executeQuery(cg, operation);
    case 'callers':
      return executeRelation(cg, operation, 'callers');
    case 'callees':
      return executeRelation(cg, operation, 'callees');
    case 'impact':
      return executeImpact(cg, operation);
    case 'node':
      return executeNode(cg, operation);
    case 'locate':
      return locateCode(cg, operation);
  }
}

function executeQuery(cg: CodeGraph, operation: BatchQueryOperation): unknown {
  const results = cg.searchNodes(operation.query, {
    limit: operation.limit ?? 10,
    kinds: operation.kind ? [operation.kind] : undefined,
  });
  return {
    query: operation.query,
    results: results.map((result) => ({
      node: summarizeNode(result.node),
      score: result.score,
      highlights: result.highlights,
    })),
  };
}

function executeRelation(
  cg: CodeGraph,
  operation: BatchRelationOperation,
  relation: 'callers' | 'callees',
): unknown {
  const matches = resolveSymbolNodes(cg, operation.symbol);
  const nodes = new Map<string, SymbolLocation>();
  const related = matches.flatMap((match) =>
    relation === 'callers' ? cg.getCallers(match.id) : cg.getCallees(match.id),
  );
  for (const entry of related) {
    nodes.set(entry.node.id, summarizeNode(entry.node));
  }
  return {
    symbol: operation.symbol,
    matchedNodes: matches.map(summarizeNode),
    [relation]: [...nodes.values()].slice(0, operation.limit ?? 20),
  };
}

function executeImpact(cg: CodeGraph, operation: BatchImpactOperation): unknown {
  const matches = resolveSymbolNodes(cg, operation.symbol);
  const nodes = new Map<string, SymbolLocation>();
  const edges = new Set<string>();
  const depth = operation.depth ?? 2;
  for (const match of matches) {
    mergeImpact(cg.getImpactRadius(match.id, depth), { nodes, edges });
  }
  const affected = [...nodes.values()].slice(0, operation.limit ?? 100);
  return {
    symbol: operation.symbol,
    depth,
    matchedNodes: matches.map(summarizeNode),
    nodeCount: nodes.size,
    edgeCount: edges.size,
    affected,
    truncated: affected.length < nodes.size,
  };
}

function mergeImpact(
  impact: Subgraph,
  result: { nodes: Map<string, SymbolLocation>; edges: Set<string> },
): void {
  for (const node of impact.nodes.values()) {
    result.nodes.set(node.id, summarizeNode(node));
  }
  for (const edge of impact.edges) {
    result.edges.add(`${edge.source}->${edge.target}:${edge.kind}`);
  }
}

function executeNode(cg: CodeGraph, operation: BatchNodeOperation): unknown {
  const matches = resolveSymbolNodes(cg, operation.symbol, operation.limit ?? 20);
  return {
    symbol: operation.symbol,
    nodes: matches.map(summarizeNode),
  };
}

function optionalBound(
  value: number | undefined,
  name: string,
  range: readonly [number, number],
): void {
  if (value === undefined) {
    return;
  }
  const [minimum, maximum] = range;
  if (Number.isInteger(value) && value >= minimum && value <= maximum) {
    return;
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
