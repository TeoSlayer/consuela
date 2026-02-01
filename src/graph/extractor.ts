/**
 * Function-level graph extractor using Tree-sitter
 * Extracts functions, calls, and analyzes purity
 */

import type {
  FunctionNode,
  CallEdge,
  FunctionGraph,
  SerializedFunctionGraph,
  PurityLevel,
  ImpurityReason,
  ImpurityPatterns,
  GraphExtractionOptions,
  GraphDiff,
} from './types.js';
import { JS_IMPURITY_PATTERNS } from './types.js';

/** Abstract base for language-specific extractors */
export abstract class FunctionExtractor {
  abstract readonly language: string;
  abstract readonly extensions: string[];

  /**
   * Extract all functions from a file's content
   */
  abstract extractFunctions(filePath: string, content: string): FunctionNode[];

  /**
   * Extract all call edges from a file's content
   */
  abstract extractCalls(filePath: string, content: string, knownFunctions: Map<string, FunctionNode>): CallEdge[];

  /**
   * Get impurity patterns for this language
   */
  abstract getImpurityPatterns(): ImpurityPatterns;
}

/**
 * JavaScript/TypeScript function extractor
 * Uses regex-based extraction (Tree-sitter version coming)
 */
export class JSFunctionExtractor extends FunctionExtractor {
  readonly language = 'javascript';
  readonly extensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs'];

  extractFunctions(filePath: string, content: string): FunctionNode[] {
    const functions: FunctionNode[] = [];
    const lines = content.split('\n');

    // Track class context for methods
    let currentClass: string | undefined;
    let classIndent = -1;

    // Track function nesting - stack of (endLine, indent)
    const functionStack: Array<{ endLine: number; indent: number }> = [];

    // Base indent level for top-level code (typically 0)
    // Functions with higher indent are likely nested
    const BASE_INDENT = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const indent = this.getIndent(line);

      // Pop functions that have ended
      while (functionStack.length > 0 && lineNum > functionStack[functionStack.length - 1].endLine) {
        functionStack.pop();
      }

      // Check if we're inside a function (nested)
      // Either we have a parent function on the stack, or we're indented beyond base level
      const isNested = functionStack.length > 0 || indent > BASE_INDENT;

      // Exit class context if we dedent
      if (currentClass && indent <= classIndent && line.trim()) {
        currentClass = undefined;
        classIndent = -1;
      }

      // Detect class declaration
      const classMatch = line.match(/^\s*(export\s+)?(abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[3];
        classIndent = indent;
        continue;
      }

      // Function declaration: function name(...) or async function name(...)
      const funcDeclMatch = line.match(
        /^\s*(export\s+)?(async\s+)?function\s*(\*?)\s*(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)/
      );
      if (funcDeclMatch) {
        const [, exported, async, generator, name, , params] = funcDeclMatch;
        const signature = this.extractSignature(lines, i);
        const endLine = this.findFunctionEnd(lines, i);

        functions.push({
          id: `${filePath}:${name}`,
          name,
          filePath,
          line: lineNum,
          endLine,
          signature,
          isExported: !!exported,
          isMethod: false,
          isNested,
          purity: 'unknown',
          impurityReasons: [],
          isAsync: !!async,
          isGenerator: !!generator,
        });

        // Push to stack for tracking nested functions
        functionStack.push({ endLine, indent });
        continue;
      }

      // Arrow function assigned to const/let/var
      const arrowMatch = line.match(
        /^\s*(export\s+)?(const|let|var)\s+(\w+)\s*(<[^>]*>)?\s*=\s*(async\s+)?\(?([^)=]*)\)?\s*=>/
      );
      if (arrowMatch) {
        const [, exported, , name, , async] = arrowMatch;
        const signature = this.extractArrowSignature(lines, i);
        const endLine = this.findArrowEnd(lines, i);

        functions.push({
          id: `${filePath}:${name}`,
          name,
          filePath,
          line: lineNum,
          endLine,
          signature,
          isExported: !!exported,
          isMethod: false,
          isNested,
          purity: 'unknown',
          impurityReasons: [],
          isAsync: !!async,
          isGenerator: false,
        });

        // Push to stack for tracking nested functions
        functionStack.push({ endLine, indent });
        continue;
      }

      // Class method (inside a class)
      if (currentClass) {
        const methodMatch = line.match(
          /^\s*(public|private|protected|static|async|readonly|\s)*(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)/
        );
        if (methodMatch && !line.includes('constructor')) {
          const name = methodMatch[2];
          if (name && !['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) {
            const isPrivate = line.includes('private') || name.startsWith('_') || name.startsWith('#');
            const signature = this.extractSignature(lines, i);
            const endLine = this.findFunctionEnd(lines, i);

            functions.push({
              id: `${filePath}:${currentClass}.${name}`,
              name: `${currentClass}.${name}`,
              filePath,
              line: lineNum,
              endLine,
              signature,
              isExported: !isPrivate,
              isMethod: true,
              isNested,
              className: currentClass,
              purity: 'unknown',
              impurityReasons: [],
              isAsync: line.includes('async'),
              isGenerator: line.includes('*'),
            });

            // Push to stack for tracking nested functions
            functionStack.push({ endLine, indent });
          }
        }
      }
    }

    return functions;
  }

  extractCalls(filePath: string, content: string, knownFunctions: Map<string, FunctionNode>): CallEdge[] {
    const edges: CallEdge[] = [];
    const lines = content.split('\n');
    const functions = this.extractFunctions(filePath, content);

    // Build a map of line ranges to function IDs
    const lineToFunction = new Map<number, string>();
    for (const func of functions) {
      for (let line = func.line; line <= func.endLine; line++) {
        lineToFunction.set(line, func.id);
      }
    }

    // Find all function calls
    const callPattern = /(\w+(?:\.\w+)*)\s*\(/g;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      const callerFuncId = lineToFunction.get(lineNum);

      if (!callerFuncId) continue; // Not inside a function

      let match;
      while ((match = callPattern.exec(line)) !== null) {
        const calleeName = match[1];

        // Skip keywords
        if (['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'typeof', 'instanceof'].includes(calleeName)) {
          continue;
        }

        // Try to find the callee in known functions
        // Check for exact match, method match, or imported function
        let calleeId: string | undefined;
        let callType: CallEdge['type'] = 'direct';

        // Direct local call
        if (knownFunctions.has(`${filePath}:${calleeName}`)) {
          calleeId = `${filePath}:${calleeName}`;
        }
        // Method call on same class
        else if (calleeName.includes('.')) {
          const possibleId = `${filePath}:${calleeName}`;
          if (knownFunctions.has(possibleId)) {
            calleeId = possibleId;
            callType = 'method';
          }
        }

        // Check if it's a constructor call
        if (line.includes(`new ${calleeName}`)) {
          callType = 'constructor';
        }

        if (calleeId) {
          edges.push({
            from: callerFuncId,
            to: calleeId,
            line: lineNum,
            type: callType,
          });
        }
      }
    }

    return edges;
  }

  getImpurityPatterns(): ImpurityPatterns {
    return JS_IMPURITY_PATTERNS;
  }

  private getIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  private extractSignature(lines: string[], startIndex: number): string {
    let signature = '';
    let parenCount = 0;
    let started = false;

    for (let i = startIndex; i < lines.length && i < startIndex + 10; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '(') {
          started = true;
          parenCount++;
        }
        if (started) {
          signature += char;
        }
        if (char === ')') {
          parenCount--;
          if (parenCount === 0) {
            // Check for return type
            const rest = line.slice(line.lastIndexOf(')') + 1);
            const returnMatch = rest.match(/:\s*([^{=]+)/);
            if (returnMatch) {
              signature += ': ' + returnMatch[1].trim();
            }
            return signature;
          }
        }
      }
      if (started) signature += ' ';
    }

    return signature || '()';
  }

  private extractArrowSignature(lines: string[], startIndex: number): string {
    const line = lines[startIndex];
    const match = line.match(/=\s*(async\s+)?\(?([^)=]*)\)?\s*=>/);
    if (match) {
      const params = match[2]?.trim() || '';
      return `(${params})`;
    }
    return '()';
  }

  private findFunctionEnd(lines: string[], startIndex: number): number {
    let braceCount = 0;
    let started = false;

    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '{') {
          started = true;
          braceCount++;
        }
        if (char === '}') {
          braceCount--;
          if (started && braceCount === 0) {
            return i + 1;
          }
        }
      }
    }

    return startIndex + 1;
  }

  private findArrowEnd(lines: string[], startIndex: number): number {
    const line = lines[startIndex];

    // Single-line arrow function
    if (!line.includes('{') || (line.includes('{') && line.includes('}'))) {
      return startIndex + 1;
    }

    // Multi-line arrow function
    return this.findFunctionEnd(lines, startIndex);
  }
}

/**
 * Analyze purity of functions based on their content
 */
export function analyzePurity(
  func: FunctionNode,
  content: string,
  patterns: ImpurityPatterns,
  knownImpure: Set<string>
): { purity: PurityLevel; reasons: ImpurityReason[] } {
  const reasons: ImpurityReason[] = [];
  const lines = content.split('\n');
  const funcContent = lines.slice(func.line - 1, func.endLine).join('\n');

  // Check for global access
  for (const pattern of patterns.globalAccess) {
    const regex = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'g');
    if (regex.test(funcContent)) {
      reasons.push({
        type: 'global',
        description: `Accesses global: ${pattern}`,
      });
    }
  }

  // Check for I/O operations
  for (const pattern of patterns.ioOperations) {
    const regex = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'g');
    if (regex.test(funcContent)) {
      reasons.push({
        type: 'io',
        description: `I/O operation: ${pattern}`,
      });
    }
  }

  // Check for non-deterministic calls
  for (const pattern of patterns.nonDeterministic) {
    const regex = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'g');
    if (regex.test(funcContent)) {
      reasons.push({
        type: 'nondeterministic',
        description: `Non-deterministic: ${pattern}`,
      });
    }
  }

  // Check for side effects
  for (const pattern of patterns.sideEffects) {
    const regex = new RegExp(`\\b${escapeRegex(pattern)}\\b`, 'g');
    if (regex.test(funcContent)) {
      reasons.push({
        type: 'external',
        description: `Side effect: ${pattern}`,
      });
    }
  }

  // Check for calls to known impure functions (infection)
  for (const impureId of knownImpure) {
    const impureName = impureId.split(':').pop()!;
    const regex = new RegExp(`\\b${escapeRegex(impureName)}\\s*\\(`, 'g');
    if (regex.test(funcContent)) {
      reasons.push({
        type: 'infected',
        description: `Calls impure function: ${impureName}`,
        infectedBy: impureId,
      });
    }
  }

  return {
    purity: reasons.length === 0 ? 'pure' : 'impure',
    reasons,
  };
}

/**
 * Compare two function graphs and return the differences
 */
export function compareGraphs(oldGraph: FunctionGraph, newGraph: FunctionGraph): GraphDiff {
  const oldIds = new Set(oldGraph.nodes.keys());
  const newIds = new Set(newGraph.nodes.keys());

  const addedFunctions = [...newIds].filter(id => !oldIds.has(id));
  const removedFunctions = [...oldIds].filter(id => !newIds.has(id));

  const signatureChanges: GraphDiff['signatureChanges'] = [];
  const purityChanges: GraphDiff['purityChanges'] = [];

  // Check for changes in common functions
  for (const id of oldIds) {
    if (newIds.has(id)) {
      const oldFunc = oldGraph.nodes.get(id)!;
      const newFunc = newGraph.nodes.get(id)!;

      if (oldFunc.signature !== newFunc.signature) {
        signatureChanges.push({
          id,
          oldSignature: oldFunc.signature,
          newSignature: newFunc.signature,
        });
      }

      if (oldFunc.purity !== newFunc.purity) {
        purityChanges.push({
          id,
          oldPurity: oldFunc.purity,
          newPurity: newFunc.purity,
        });
      }
    }
  }

  // Compare edges
  const oldEdgeSet = new Set(oldGraph.edges.map(e => `${e.from}->${e.to}`));
  const newEdgeSet = new Set(newGraph.edges.map(e => `${e.from}->${e.to}`));

  const addedEdges = newGraph.edges.filter(e => !oldEdgeSet.has(`${e.from}->${e.to}`));
  const removedEdges = oldGraph.edges.filter(e => !newEdgeSet.has(`${e.from}->${e.to}`));

  const isEquivalent =
    addedFunctions.length === 0 &&
    removedFunctions.length === 0 &&
    signatureChanges.length === 0 &&
    addedEdges.length === 0 &&
    removedEdges.length === 0;

  const summary: string[] = [];
  if (addedFunctions.length > 0) summary.push(`Added ${addedFunctions.length} function(s)`);
  if (removedFunctions.length > 0) summary.push(`Removed ${removedFunctions.length} function(s)`);
  if (signatureChanges.length > 0) summary.push(`Changed ${signatureChanges.length} signature(s)`);
  if (addedEdges.length > 0) summary.push(`Added ${addedEdges.length} call(s)`);
  if (removedEdges.length > 0) summary.push(`Removed ${removedEdges.length} call(s)`);
  if (purityChanges.length > 0) summary.push(`${purityChanges.length} purity change(s)`);

  return {
    addedFunctions,
    removedFunctions,
    signatureChanges,
    addedEdges,
    removedEdges,
    purityChanges,
    isEquivalent,
    summary: summary.length > 0 ? summary : ['No structural changes'],
  };
}

/**
 * Serialize a FunctionGraph to JSON-compatible format
 */
export function serializeGraph(graph: FunctionGraph): SerializedFunctionGraph {
  return {
    version: graph.version,
    generatedAt: graph.generatedAt,
    rootDir: graph.rootDir,
    nodes: Object.fromEntries(graph.nodes),
    edges: graph.edges,
    files: graph.files,
    stats: graph.stats,
  };
}

/**
 * Deserialize a FunctionGraph from JSON
 */
export function deserializeGraph(data: SerializedFunctionGraph): FunctionGraph {
  return {
    version: data.version,
    generatedAt: data.generatedAt,
    rootDir: data.rootDir,
    nodes: new Map(Object.entries(data.nodes)),
    edges: data.edges,
    files: data.files,
    stats: data.stats,
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
