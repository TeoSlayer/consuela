/**
 * GraphAnalyzer - Builds and manages function-level graphs
 * This is the core of Esmeralda's structural verification
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type {
  FunctionGraph,
  SerializedFunctionGraph,
  FunctionNode,
  CallEdge,
  GraphExtractionOptions,
  GraphDiff,
} from './types.js';
import {
  JSFunctionExtractor,
  FunctionExtractor,
  analyzePurity,
  compareGraphs,
  serializeGraph,
  deserializeGraph,
} from './extractor.js';
import { createGeminiClient, type SemanticAnalysisResult } from '../core/gemini.js';
import { hasGlobalApiKey, getGlobalApiKey } from '../commands/config.js';

const GRAPH_VERSION = '1.0.0';
const GRAPH_FILE = 'graph.json';

export interface GraphAnalyzerConfig {
  rootDir: string;
  exclude?: string[];
  options?: GraphExtractionOptions;
}

export class GraphAnalyzer {
  private readonly rootDir: string;
  private readonly exclude: string[];
  private readonly options: GraphExtractionOptions;
  private readonly extractors: Map<string, FunctionExtractor> = new Map();

  constructor(config: GraphAnalyzerConfig) {
    this.rootDir = config.rootDir;
    this.exclude = config.exclude || [
      'node_modules', '.git', 'dist', 'build', 'coverage',
      '*.test.*', '*.spec.*', '__tests__',
    ];
    this.options = config.options || {
      includeAnonymous: false,
      includeMethods: true,
    };

    // Register extractors
    const jsExtractor = new JSFunctionExtractor();
    for (const ext of jsExtractor.extensions) {
      this.extractors.set(ext, jsExtractor);
    }
  }

  /**
   * Build a complete function graph for the codebase
   */
  async buildGraph(): Promise<FunctionGraph> {
    const files = await this.getFiles();
    const allFunctions = new Map<string, FunctionNode>();
    const allEdges: CallEdge[] = [];

    // First pass: Extract all functions
    for (const file of files) {
      const content = fs.readFileSync(path.join(this.rootDir, file), 'utf-8');
      const extractor = this.getExtractor(file);
      if (!extractor) continue;

      const functions = extractor.extractFunctions(file, content);
      for (const func of functions) {
        allFunctions.set(func.id, func);
      }
    }

    // Second pass: Extract all calls and analyze purity
    const knownImpure = new Set<string>();

    // Initial purity pass (without infection tracking)
    for (const file of files) {
      const content = fs.readFileSync(path.join(this.rootDir, file), 'utf-8');
      const extractor = this.getExtractor(file);
      if (!extractor) continue;

      const patterns = extractor.getImpurityPatterns();

      for (const [id, func] of allFunctions) {
        if (!id.startsWith(file)) continue;

        const { purity, reasons } = analyzePurity(func, content, patterns, new Set());
        func.purity = purity;
        func.impurityReasons = reasons;

        if (purity === 'impure') {
          knownImpure.add(id);
        }
      }
    }

    // Infection propagation pass (iterative until stable)
    let changed = true;
    while (changed) {
      changed = false;
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.rootDir, file), 'utf-8');
        const extractor = this.getExtractor(file);
        if (!extractor) continue;

        const patterns = extractor.getImpurityPatterns();

        for (const [id, func] of allFunctions) {
          if (!id.startsWith(file)) continue;
          if (func.purity === 'impure') continue; // Already impure

          const { purity, reasons } = analyzePurity(func, content, patterns, knownImpure);
          if (purity === 'impure') {
            func.purity = purity;
            func.impurityReasons = reasons;
            knownImpure.add(id);
            changed = true;
          }
        }
      }
    }

    // Mark remaining unknown as pure
    for (const func of allFunctions.values()) {
      if (func.purity === 'unknown') {
        func.purity = 'pure';
      }
    }

    // Third pass: Extract call edges
    for (const file of files) {
      const content = fs.readFileSync(path.join(this.rootDir, file), 'utf-8');
      const extractor = this.getExtractor(file);
      if (!extractor) continue;

      const edges = extractor.extractCalls(file, content, allFunctions);
      allEdges.push(...edges);
    }

    // Build stats
    const stats = {
      totalFunctions: allFunctions.size,
      pureFunctions: [...allFunctions.values()].filter(f => f.purity === 'pure').length,
      impureFunctions: [...allFunctions.values()].filter(f => f.purity === 'impure').length,
      unknownFunctions: [...allFunctions.values()].filter(f => f.purity === 'unknown').length,
      totalCalls: allEdges.length,
      exportedFunctions: [...allFunctions.values()].filter(f => f.isExported).length,
    };

    return {
      version: GRAPH_VERSION,
      generatedAt: new Date().toISOString(),
      rootDir: this.rootDir,
      nodes: allFunctions,
      edges: allEdges,
      files,
      stats,
    };
  }

  /**
   * Save a graph as the "Gold Standard"
   */
  saveGoldStandard(graph: FunctionGraph): void {
    const configDir = path.join(this.rootDir, '.consuela');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const graphPath = path.join(configDir, GRAPH_FILE);
    const serialized = serializeGraph(graph);
    fs.writeFileSync(graphPath, JSON.stringify(serialized, null, 2));
  }

  /**
   * Load the Gold Standard graph
   */
  loadGoldStandard(): FunctionGraph | null {
    const graphPath = path.join(this.rootDir, '.consuela', GRAPH_FILE);
    if (!fs.existsSync(graphPath)) {
      return null;
    }

    const data = JSON.parse(fs.readFileSync(graphPath, 'utf-8')) as SerializedFunctionGraph;
    return deserializeGraph(data);
  }

  /**
   * Verify current code against the Gold Standard
   */
  async verify(): Promise<{ valid: boolean; diff: GraphDiff }> {
    const goldStandard = this.loadGoldStandard();
    if (!goldStandard) {
      throw new Error('No Gold Standard found. Run `consuela scan` first.');
    }

    const currentGraph = await this.buildGraph();
    const diff = compareGraphs(goldStandard, currentGraph);

    return {
      valid: diff.isEquivalent,
      diff,
    };
  }

  /**
   * Verify that a specific file change doesn't break the graph
   */
  async verifyFileChange(filePath: string, newContent: string): Promise<{ valid: boolean; diff: GraphDiff }> {
    const goldStandard = this.loadGoldStandard();
    if (!goldStandard) {
      throw new Error('No Gold Standard found. Run `consuela scan` first.');
    }

    // Build graph with the new content
    const relativePath = path.relative(this.rootDir, filePath);
    const extractor = this.getExtractor(relativePath);
    if (!extractor) {
      throw new Error(`No extractor found for file: ${relativePath}`);
    }

    // Extract functions and calls from new content
    const newFunctions = extractor.extractFunctions(relativePath, newContent);
    const tempFuncMap = new Map<string, FunctionNode>();
    for (const func of newFunctions) {
      tempFuncMap.set(func.id, func);
    }
    const newEdges = extractor.extractCalls(relativePath, newContent, tempFuncMap);

    // Create a modified graph with the new file's functions
    const modifiedGraph: FunctionGraph = {
      ...goldStandard,
      nodes: new Map(goldStandard.nodes),
      edges: [...goldStandard.edges],
    };

    // Remove old functions from this file
    for (const id of goldStandard.nodes.keys()) {
      if (id.startsWith(relativePath + ':')) {
        modifiedGraph.nodes.delete(id);
      }
    }

    // Remove old edges involving this file
    modifiedGraph.edges = modifiedGraph.edges.filter(
      e => !e.from.startsWith(relativePath + ':') && !e.to.startsWith(relativePath + ':')
    );

    // Add new functions
    for (const func of newFunctions) {
      modifiedGraph.nodes.set(func.id, func);
    }

    // Add new edges
    modifiedGraph.edges.push(...newEdges);

    // Compare with gold standard
    const diff = compareGraphs(goldStandard, modifiedGraph);

    return {
      valid: diff.isEquivalent,
      diff,
    };
  }

  /**
   * Get all pure functions
   */
  async getPureFunctions(): Promise<FunctionNode[]> {
    const graph = await this.buildGraph();
    return [...graph.nodes.values()].filter(f => f.purity === 'pure');
  }

  /**
   * Get all impure functions with their reasons
   */
  async getImpureFunctions(): Promise<FunctionNode[]> {
    const graph = await this.buildGraph();
    return [...graph.nodes.values()].filter(f => f.purity === 'impure');
  }

  // ============================================================================
  // Graph Traversal & Analysis Algorithms
  // ============================================================================

  /**
   * BFS traversal from a starting node - find all reachable functions
   */
  bfsFrom(graph: FunctionGraph, startId: string, direction: 'callers' | 'callees' = 'callees'): string[] {
    const visited = new Set<string>();
    const queue: string[] = [startId];
    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      result.push(current);

      // Find neighbors based on direction
      const neighbors = direction === 'callees'
        ? graph.edges.filter(e => e.from === current).map(e => e.to)
        : graph.edges.filter(e => e.to === current).map(e => e.from);

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }

  /**
   * DFS traversal - find dependency chains
   */
  dfsFrom(graph: FunctionGraph, startId: string, direction: 'callers' | 'callees' = 'callees'): string[] {
    const visited = new Set<string>();
    const result: string[] = [];

    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      result.push(id);

      const neighbors = direction === 'callees'
        ? graph.edges.filter(e => e.from === id).map(e => e.to)
        : graph.edges.filter(e => e.to === id).map(e => e.from);

      for (const neighbor of neighbors) {
        visit(neighbor);
      }
    };

    visit(startId);
    return result;
  }

  /**
   * Find shortest path between two functions (Dijkstra-style BFS)
   */
  shortestPath(graph: FunctionGraph, fromId: string, toId: string): string[] | null {
    if (fromId === toId) return [fromId];

    const visited = new Set<string>();
    const queue: Array<{ id: string; path: string[] }> = [{ id: fromId, path: [fromId] }];

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const callees = graph.edges.filter(e => e.from === id).map(e => e.to);
      for (const callee of callees) {
        if (callee === toId) {
          return [...path, callee];
        }
        if (!visited.has(callee)) {
          queue.push({ id: callee, path: [...path, callee] });
        }
      }
    }

    return null; // No path found
  }

  /**
   * Calculate centrality scores - find the most "important" functions
   * Uses degree centrality (in + out edges) as a simple metric
   */
  calculateCentrality(graph: FunctionGraph): Map<string, number> {
    const centrality = new Map<string, number>();

    // Initialize all nodes with 0
    for (const id of graph.nodes.keys()) {
      centrality.set(id, 0);
    }

    // Count edges
    for (const edge of graph.edges) {
      centrality.set(edge.from, (centrality.get(edge.from) || 0) + 1);
      centrality.set(edge.to, (centrality.get(edge.to) || 0) + 1);
    }

    return centrality;
  }

  /**
   * Find hub functions - high connectivity, critical to the codebase
   */
  findHubs(graph: FunctionGraph, threshold: number = 5): FunctionNode[] {
    const centrality = this.calculateCentrality(graph);
    const hubs: FunctionNode[] = [];

    for (const [id, score] of centrality) {
      if (score >= threshold) {
        const node = graph.nodes.get(id);
        if (node) hubs.push(node);
      }
    }

    return hubs.sort((a, b) =>
      (centrality.get(b.id) || 0) - (centrality.get(a.id) || 0)
    );
  }

  /**
   * Find clusters of related functions (functions that call each other)
   * Uses a simple connected components algorithm
   */
  findClusters(graph: FunctionGraph): Map<string, string[]> {
    const clusters = new Map<string, string[]>();
    const visited = new Set<string>();

    // Build undirected adjacency for clustering
    const adjacency = new Map<string, Set<string>>();
    for (const id of graph.nodes.keys()) {
      adjacency.set(id, new Set());
    }
    for (const edge of graph.edges) {
      adjacency.get(edge.from)?.add(edge.to);
      adjacency.get(edge.to)?.add(edge.from);
    }

    // Find connected components
    for (const startId of graph.nodes.keys()) {
      if (visited.has(startId)) continue;

      const component: string[] = [];
      const queue = [startId];

      while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        component.push(id);

        for (const neighbor of adjacency.get(id) || []) {
          if (!visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }

      if (component.length > 1) {
        // Use the first node's file as cluster key
        const file = component[0].split(':')[0];
        clusters.set(file, component);
      }
    }

    return clusters;
  }

  /**
   * Find functions that are safe to extract together
   * (they form a self-contained subgraph with minimal external dependencies)
   */
  findExtractableGroups(graph: FunctionGraph, file: string): Array<{
    functions: string[];
    internalEdges: number;
    externalDependencies: string[];
    score: number; // Higher = better candidate for extraction
  }> {
    // Get all standalone functions in this file (exclude class methods and nested functions)
    // Class methods have names like "ClassName.methodName" and aren't extractable by split
    // Nested functions are closures that reference parent scope and can't be extracted
    const fileFunctions = [...graph.nodes.keys()].filter(id => {
      if (!id.startsWith(file + ':')) return false;
      const node = graph.nodes.get(id);
      // Exclude class methods and nested functions
      return node && !node.isMethod && !node.isNested;
    });
    if (fileFunctions.length < 2) return [];

    const groups: Array<{
      functions: string[];
      internalEdges: number;
      externalDependencies: string[];
      score: number;
    }> = [];

    // For each function, find its call subgraph within the file
    for (const funcId of fileFunctions) {
      const reachable = this.bfsFrom(graph, funcId, 'callees')
        .filter(id => {
          if (!id.startsWith(file + ':')) return false;
          // Also exclude nested functions from reachable set
          const node = graph.nodes.get(id);
          return node && !node.isMethod && !node.isNested;
        });

      if (reachable.length > 1 && reachable.length < fileFunctions.length * 0.7) {
        // Count internal vs external edges
        let internalEdges = 0;
        const externalDeps = new Set<string>();

        for (const id of reachable) {
          for (const edge of graph.edges) {
            if (edge.from === id) {
              if (reachable.includes(edge.to)) {
                internalEdges++;
              } else {
                externalDeps.add(edge.to);
              }
            }
          }
        }

        // Score: high internal cohesion, low external coupling
        const score = internalEdges / (externalDeps.size + 1);

        groups.push({
          functions: reachable,
          internalEdges,
          externalDependencies: [...externalDeps],
          score,
        });
      }
    }

    // Sort by score and dedupe overlapping groups
    groups.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    return groups.filter(g => {
      const key = g.functions.sort().join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5); // Top 5 candidates
  }

  /**
   * Analyze file coupling - which files are tightly coupled?
   */
  analyzeFileCoupling(graph: FunctionGraph): Array<{
    file1: string;
    file2: string;
    edgeCount: number;
    direction: 'bidirectional' | 'file1->file2' | 'file2->file1';
  }> {
    const coupling = new Map<string, { forward: number; backward: number }>();

    for (const edge of graph.edges) {
      const file1 = edge.from.split(':')[0];
      const file2 = edge.to.split(':')[0];
      if (file1 === file2) continue;

      const key = [file1, file2].sort().join('|');
      const existing = coupling.get(key) || { forward: 0, backward: 0 };

      if (file1 < file2) {
        existing.forward++;
      } else {
        existing.backward++;
      }
      coupling.set(key, existing);
    }

    const results: Array<{
      file1: string;
      file2: string;
      edgeCount: number;
      direction: 'bidirectional' | 'file1->file2' | 'file2->file1';
    }> = [];

    for (const [key, counts] of coupling) {
      const [file1, file2] = key.split('|');
      const total = counts.forward + counts.backward;

      let direction: 'bidirectional' | 'file1->file2' | 'file2->file1';
      if (counts.forward > 0 && counts.backward > 0) {
        direction = 'bidirectional';
      } else if (counts.forward > 0) {
        direction = 'file1->file2';
      } else {
        direction = 'file2->file1';
      }

      results.push({ file1, file2, edgeCount: total, direction });
    }

    return results.sort((a, b) => b.edgeCount - a.edgeCount);
  }

  /**
   * Get a summary of graph insights for AI decision making
   */
  async getGraphInsights(): Promise<{
    hubs: Array<{ name: string; file: string; connections: number }>;
    tightlyCoupledFiles: Array<{ files: string[]; edges: number }>;
    extractionCandidates: Array<{ file: string; functions: string[]; score: number }>;
    isolatedFunctions: string[];
    criticalPaths: Array<{ from: string; to: string; length: number }>;
  }> {
    const graph = await this.buildGraph();
    const centrality = this.calculateCentrality(graph);

    // Find hub functions
    const hubs = this.findHubs(graph, 4).slice(0, 10).map(node => ({
      name: node.name,
      file: node.id.split(':')[0],
      connections: centrality.get(node.id) || 0,
    }));

    // Find tightly coupled files
    const coupling = this.analyzeFileCoupling(graph);
    const tightlyCoupledFiles = coupling
      .filter(c => c.edgeCount >= 3)
      .slice(0, 5)
      .map(c => ({ files: [c.file1, c.file2], edges: c.edgeCount }));

    // Find extraction candidates for large files
    const fileSizes = new Map<string, number>();
    for (const id of graph.nodes.keys()) {
      const file = id.split(':')[0];
      fileSizes.set(file, (fileSizes.get(file) || 0) + 1);
    }

    const extractionCandidates: Array<{ file: string; functions: string[]; score: number }> = [];
    for (const [file, size] of fileSizes) {
      if (size >= 10) { // Large file
        const groups = this.findExtractableGroups(graph, file);
        for (const group of groups.slice(0, 2)) {
          extractionCandidates.push({
            file,
            functions: group.functions.map(id => id.split(':')[1]),
            score: group.score,
          });
        }
      }
    }

    // Find isolated functions (no connections)
    const isolatedFunctions = [...graph.nodes.keys()].filter(id => {
      const hasOutgoing = graph.edges.some(e => e.from === id);
      const hasIncoming = graph.edges.some(e => e.to === id);
      return !hasOutgoing && !hasIncoming;
    });

    // Find some critical paths (longest dependency chains)
    const criticalPaths: Array<{ from: string; to: string; length: number }> = [];
    const exportedFuncs = [...graph.nodes.values()].filter(n => n.isExported);

    for (const func of exportedFuncs.slice(0, 20)) {
      const reachable = this.bfsFrom(graph, func.id, 'callees');
      if (reachable.length > 3) {
        criticalPaths.push({
          from: func.name,
          to: reachable[reachable.length - 1].split(':')[1],
          length: reachable.length,
        });
      }
    }

    return {
      hubs,
      tightlyCoupledFiles,
      extractionCandidates: extractionCandidates.slice(0, 5),
      isolatedFunctions: isolatedFunctions.slice(0, 10),
      criticalPaths: criticalPaths.sort((a, b) => b.length - a.length).slice(0, 5),
    };
  }

  private async getFiles(): Promise<string[]> {
    const patterns = this.extractors.size > 0
      ? [...new Set([...this.extractors.keys()].map(ext => `**/*${ext}`))]
      : ['**/*.{js,jsx,ts,tsx,mjs}'];

    const ignorePatterns = this.exclude.map(p => {
      if (p.includes('*')) return `**/${p}`;
      return `**/${p}/**`;
    });

    const files = await glob(patterns, {
      cwd: this.rootDir,
      ignore: ignorePatterns,
      nodir: true,
    });

    return files;
  }

  private getExtractor(filePath: string): FunctionExtractor | undefined {
    const ext = path.extname(filePath);
    return this.extractors.get(ext);
  }

  /**
   * Use AI to semantically analyze functions in a file and group by responsibility
   */
  async getSemanticExtractionCandidates(
    file: string,
    minGroupSize: number = 100
  ): Promise<SemanticAnalysisResult | null> {
    if (!hasGlobalApiKey()) {
      return null;
    }

    const filePath = path.join(this.rootDir, file);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const graph = await this.buildGraph();

    const fileFunctions = [...graph.nodes.entries()]
      .filter(([id]) => id.startsWith(file + ':'))
      .map(([, node]) => {
        const lines = content.split('\n');
        const startLine = node.line - 1;
        const endLine = node.endLine;
        const rawLine = lines[startLine] || '';
        let signature = rawLine.trim();
        if (signature.length > 100) {
          signature = signature.slice(0, 100) + '...';
        }
        // Check indentation - inner functions are indented
        const indentation = rawLine.match(/^(\s*)/)?.[1].length || 0;
        return {
          name: node.name,
          signature,
          lineCount: endLine - startLine + 1,
          indentation,
        };
      })
      .filter(f => !f.name.includes('.'))
      .filter(f => f.lineCount >= 10)
      .filter(f => f.indentation === 0) // Only top-level functions (no indentation)
      .filter(f => {
        // Must look like a function declaration
        const funcPatterns = /^(export\s+)?(async\s+)?function|^(export\s+)?const\s+\w+\s*=/;
        return funcPatterns.test(f.signature);
      });

    if (fileFunctions.length < 3) {
      return null;
    }

    try {
      const apiKey = getGlobalApiKey();
      if (!apiKey) return null;
      const gemini = createGeminiClient(apiKey);
      return await gemini.analyzeSemanticGroups(file, fileFunctions, minGroupSize);
    } catch {
      return null;
    }
  }
}

/**
 * Create a configured GraphAnalyzer
 */
export function createGraphAnalyzer(rootDir: string = process.cwd()): GraphAnalyzer {
  return new GraphAnalyzer({ rootDir });
}
