/**
 * Function-level graph types for structural analysis
 * This enables Esmeralda's "structural AI refactoring" capabilities
 */

/** Purity classification for functions */
export type PurityLevel = 'pure' | 'impure' | 'unknown';

/** Reason why a function is impure */
export interface ImpurityReason {
  type: 'io' | 'global' | 'nondeterministic' | 'infected' | 'external';
  description: string;
  line?: number;
  /** If infected, which impure function caused it */
  infectedBy?: string;
}

/** A function node in the call graph */
export interface FunctionNode {
  /** Unique ID: "filePath:functionName" or "filePath:line:functionName" for anonymous */
  id: string;
  /** Function name (or "<anonymous>" for unnamed functions) */
  name: string;
  /** File containing this function */
  filePath: string;
  /** Line number where function is defined */
  line: number;
  /** End line of function */
  endLine: number;
  /** Function signature (params + return type if available) */
  signature: string;
  /** Whether this function is exported */
  isExported: boolean;
  /** Whether this is a method on a class */
  isMethod: boolean;
  /** Parent class name if this is a method */
  className?: string;
  /** Whether this is a nested/inner function (closure) */
  isNested: boolean;
  /** Purity classification */
  purity: PurityLevel;
  /** Reasons for impurity (if impure) */
  impurityReasons: ImpurityReason[];
  /** Is this an async function */
  isAsync: boolean;
  /** Is this a generator function */
  isGenerator: boolean;
}

/** An edge in the call graph (function A calls function B) */
export interface CallEdge {
  /** Caller function ID */
  from: string;
  /** Callee function ID */
  to: string;
  /** Line where the call occurs */
  line: number;
  /** Type of call */
  type: 'direct' | 'method' | 'callback' | 'constructor';
}

/** Known impure patterns to detect */
export interface ImpurityPatterns {
  /** Global variable access patterns */
  globalAccess: string[];
  /** I/O operation patterns (console, fs, fetch, etc.) */
  ioOperations: string[];
  /** Non-deterministic function calls */
  nonDeterministic: string[];
  /** External/side-effect patterns */
  sideEffects: string[];
}

/** Default impurity patterns for JavaScript/TypeScript */
export const JS_IMPURITY_PATTERNS: ImpurityPatterns = {
  globalAccess: [
    'window', 'document', 'global', 'globalThis',
    'process', 'localStorage', 'sessionStorage',
  ],
  ioOperations: [
    'console.log', 'console.error', 'console.warn', 'console.info',
    'fetch', 'XMLHttpRequest',
    'fs.readFile', 'fs.writeFile', 'fs.readFileSync', 'fs.writeFileSync',
    'require', 'import',
  ],
  nonDeterministic: [
    'Date.now', 'new Date', 'Math.random',
    'crypto.randomUUID', 'crypto.getRandomValues',
    'performance.now',
  ],
  sideEffects: [
    'setTimeout', 'setInterval', 'setImmediate',
    'addEventListener', 'removeEventListener',
    'dispatchEvent', 'emit',
  ],
};
/** The complete function-level graph for a codebase */
export interface FunctionGraph {
  /** Version for compatibility checking */
  version: string;
  /** When this graph was generated */
  generatedAt: string;
  /** Root directory of the analyzed codebase */
  rootDir: string;
  /** All function nodes indexed by ID */
  nodes: Map<string, FunctionNode>;
  /** All call edges */
  edges: CallEdge[];
  /** Files included in this graph */
  files: string[];
  /** Summary statistics */
  stats: {
    totalFunctions: number;
    pureFunctions: number;
    impureFunctions: number;
    unknownFunctions: number;
    totalCalls: number;
    exportedFunctions: number;
  };
}

/** Serializable version of FunctionGraph for JSON export */
export interface SerializedFunctionGraph {
  version: string;
  generatedAt: string;
  rootDir: string;
  nodes: Record<string, FunctionNode>;
  edges: CallEdge[];
  files: string[];
  stats: FunctionGraph['stats'];
}

/** Result of comparing two graphs */
export interface GraphDiff {
  /** Functions added in the new graph */
  addedFunctions: string[];
  /** Functions removed from the old graph */
  removedFunctions: string[];
  /** Functions whose signatures changed */
  signatureChanges: Array<{
    id: string;
    oldSignature: string;
    newSignature: string;
  }>;
  /** Call edges added */
  addedEdges: CallEdge[];
  /** Call edges removed */
  removedEdges: CallEdge[];
  /** Purity changes */
  purityChanges: Array<{
    id: string;
    oldPurity: PurityLevel;
    newPurity: PurityLevel;
  }>;
  /** Whether the graphs are structurally equivalent */
  isEquivalent: boolean;
  /** Human-readable summary of changes */
  summary: string[];
}

/** Options for graph extraction */
export interface GraphExtractionOptions {
  /** Include anonymous functions */
  includeAnonymous?: boolean;
  /** Include class methods */
  includeMethods?: boolean;
  /** Custom impurity patterns to add */
  customImpurityPatterns?: Partial<ImpurityPatterns>;
  /** Files/patterns to exclude */
  exclude?: string[];
}
