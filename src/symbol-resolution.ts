import type CodeGraph from './index';
import type { Node } from './types';
import { isGeneratedFile } from './extraction/generated-detection';

const MAX_REFERENCE_LENGTH = 10_000;
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

export interface SymbolLocation {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

/**
 * Resolve a stable node ID, bare symbol, or qualified symbol to definitions.
 * Safe for concurrent calls on independent CodeGraph instances; callers must
 * serialize access when sharing one instance across threads.
 */
export function resolveSymbolNodes(
  cg: CodeGraph,
  reference: string,
  limit = 50,
): Node[] {
  const symbol = requireReference(reference);
  const boundedLimit = boundInteger(limit, 'limit', [1, 200]);
  const byId = cg.getNode(symbol);
  if (byId) {
    return [byId];
  }

  if (!isQualified(symbol)) {
    const exact = cg.getNodesByName(symbol);
    if (exact.length > 0) {
      return rankNodes(exact).slice(0, boundedLimit);
    }
    const fuzzy = cg.searchNodes(symbol, { limit: boundedLimit });
    return fuzzy[0] ? [fuzzy[0].node] : [];
  }

  const tail = lastQualifierPart(symbol);
  const exactTail = cg.getNodesByName(tail);
  const candidates = exactTail.length > 0
    ? exactTail
    : cg.searchNodes(tail, { limit: boundedLimit }).map((result) => result.node);
  return rankNodes(candidates.filter((node) => matchesSymbol(node, symbol)))
    .slice(0, boundedLimit);
}

export function summarizeNode(node: Node): SymbolLocation {
  const result: SymbolLocation = {
    id: node.id,
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
  };
  if (node.signature) {
    result.signature = node.signature;
  }
  return result;
}

export function matchesSymbol(node: Node, reference: string): boolean {
  const symbol = reference.trim();
  if (node.id === symbol || node.name === symbol || node.qualifiedName === symbol) {
    return true;
  }
  if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) {
    return true;
  }
  if (!isQualified(symbol)) {
    return false;
  }

  const parts = qualifierParts(symbol);
  if (parts.length < 2 || node.name !== parts[parts.length - 1]) {
    return false;
  }
  const qualifiedSuffix = parts.join('::');
  if (
    node.qualifiedName === qualifiedSuffix ||
    node.qualifiedName.endsWith(`::${qualifiedSuffix}`)
  ) {
    return true;
  }

  const containerHints = parts
    .slice(0, -1)
    .filter((part) => !RUST_PATH_PREFIXES.has(part));
  if (containerHints.length === 0) {
    return false;
  }
  const segments = node.filePath.split('/').filter(Boolean);
  return containerHints.every((hint) =>
    segments.some((segment) => segment === hint || segment.replace(/\.[^.]+$/, '') === hint),
  );
}

function rankNodes(nodes: Node[]): Node[] {
  return [...nodes].sort((left, right) => {
    const generatedOrder = Number(isGeneratedFile(left.filePath)) - Number(isGeneratedFile(right.filePath));
    if (generatedOrder !== 0) {
      return generatedOrder;
    }
    return left.filePath.localeCompare(right.filePath) || left.startLine - right.startLine;
  });
}

function qualifierParts(symbol: string): string[] {
  return symbol.split(/::|[./]/).filter(Boolean);
}

function lastQualifierPart(symbol: string): string {
  const parts = qualifierParts(symbol);
  return parts[parts.length - 1] ?? symbol;
}

function isQualified(symbol: string): boolean {
  return /[./]|::/.test(symbol);
}

function requireReference(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('symbol reference must be a non-empty string');
  }
  const reference = value.trim();
  if (reference.length > MAX_REFERENCE_LENGTH) {
    throw new Error(`symbol reference may contain at most ${MAX_REFERENCE_LENGTH} characters`);
  }
  return reference;
}

function boundInteger(
  value: number,
  name: string,
  range: readonly [number, number],
): number {
  const [minimum, maximum] = range;
  if (Number.isInteger(value) && value >= minimum && value <= maximum) {
    return value;
  }
  throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
}
