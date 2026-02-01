import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConfiguredAnalyzer } from '../../core/index.js';
import { createGraphAnalyzer } from '../../graph/index.js';

interface DiagnosisResult {
  score: number;
  problems: Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    file?: string;
    message: string;
    suggestion?: string;
  }>;
  stats: {
    totalFiles: number;
    totalFunctions: number;
    unusedExports: number;
    largestFile: { path: string; lines: number };
  };
  /** Graph-based insights for smarter decisions */
  graphInsights?: {
    hubs: Array<{ name: string; file: string; connections: number }>;
    tightlyCoupledFiles: Array<{ files: string[]; edges: number }>;
    extractionCandidates: Array<{ file: string; functions: string[]; score: number }>;
    isolatedFunctions: string[];
    criticalPaths: Array<{ from: string; to: string; length: number }>;
  };
}

/**
 * Count lines changed between two contents
 */
export function countLinesChanged(original: string, modified: string): number {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');

  // Simple diff - count lines that differ
  const maxLen = Math.max(origLines.length, modLines.length);
  let changed = 0;

  for (let i = 0; i < maxLen; i++) {
    if (origLines[i] !== modLines[i]) {
      changed++;
    }
  }

  // Also count net line difference
  changed += Math.abs(origLines.length - modLines.length);

  return changed;
}

/**
 * Get current codebase statistics
 */
export async function getCodebaseStats() {
  const analyzer = createConfiguredAnalyzer();
  const graphAnalyzer = createGraphAnalyzer();

  const [analysis, graph] = await Promise.all([
    analyzer.analyze(),
    graphAnalyzer.buildGraph(),
  ]);

  const unusedExports = analyzer.findUnusedExports(analysis)
    .filter(u => !u.reason.includes('Entry point'));

  // Count problems
  let criticalIssues = 0;
  let warnings = 0;

  for (const file of graph.files) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      const lines = content.split('\n').length;
      if (lines > 500) criticalIssues++;
      else if (lines > 300) warnings++;
    } catch {
      // Ignore file read errors
    }
  }

  return {
    files: graph.files.length,
    functions: graph.stats.totalFunctions,
    unusedExports: unusedExports.length,
    criticalIssues,
    warnings,
  };
}

/**
 * Run diagnosis on codebase
 */
export async function diagnoseCodebase(): Promise<DiagnosisResult> {
  const analyzer = createConfiguredAnalyzer();
  const graphAnalyzer = createGraphAnalyzer();

  const [analysis, graph] = await Promise.all([
    analyzer.analyze(),
    graphAnalyzer.buildGraph(),
  ]);

  const problems: DiagnosisResult['problems'] = [];
  const fileSizes = new Map<string, number>();

  // Collect file stats
  for (const file of graph.files) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      const lines = content.split('\n').length;
      fileSizes.set(file, lines);
    } catch {
      fileSizes.set(file, 0);
    }
  }

  // Find largest file
  let largestFile = { path: '', lines: 0 };
  for (const [file, lines] of fileSizes) {
    if (lines > largestFile.lines) {
      largestFile = { path: file, lines };
    }
  }

  // Problem: Large files
  for (const [file, lines] of fileSizes) {
    if (lines > 500) {
      problems.push({
        severity: 'critical',
        category: 'file-size',
        file,
        message: `${lines} lines`,
        suggestion: 'Split into smaller modules',
      });
    } else if (lines > 300) {
      problems.push({
        severity: 'warning',
        category: 'file-size',
        file,
        message: `${lines} lines`,
        suggestion: 'Consider splitting',
      });
    }
  }

  // Problem: Unused exports
  const unusedExports = analyzer.findUnusedExports(analysis)
    .filter(u => !u.reason.includes('Entry point'));

  for (const unused of unusedExports) {
    problems.push({
      severity: 'warning',
      category: 'dead-code',
      file: unused.export.filePath,
      message: `Unused: ${unused.export.name}`,
      suggestion: 'Remove dead code',
    });
  }

  // Calculate health score using category-based scoring with diminishing returns
  const categoryPenalties: Record<string, { count: number; maxPenalty: number }> = {
    'file-size': { count: 0, maxPenalty: 25 },
    'complexity': { count: 0, maxPenalty: 15 },
    'dead-code': { count: 0, maxPenalty: 20 },
    'duplicate': { count: 0, maxPenalty: 10 },
    'architecture': { count: 0, maxPenalty: 15 },
    'circular': { count: 0, maxPenalty: 15 },
  };

  for (const problem of problems) {
    const cat = categoryPenalties[problem.category];
    if (cat) cat.count++;
  }

  let score = 100;
  for (const [, { count, maxPenalty }] of Object.entries(categoryPenalties)) {
    if (count > 0) {
      const penalty = maxPenalty * (1 - Math.exp(-count / 3));
      score -= penalty;
    }
  }
  score = Math.max(0, Math.round(score));

  // Get graph insights for smarter AI decisions
  const graphInsights = await graphAnalyzer.getGraphInsights();

  // Add graph-based problems
  // Tightly coupled files that might benefit from merging
  for (const couple of graphInsights.tightlyCoupledFiles) {
    if (couple.edges >= 5) {
      problems.push({
        severity: 'info',
        category: 'coupling',
        file: couple.files.join(' <-> '),
        message: `High coupling (${couple.edges} cross-file calls)`,
        suggestion: 'Consider merging these files or extracting shared code',
      });
    }
  }

  // Isolated functions that might be dead code
  for (const isolated of graphInsights.isolatedFunctions.slice(0, 5)) {
    const [file, func] = isolated.split(':');
    problems.push({
      severity: 'info',
      category: 'isolated',
      file,
      message: `Isolated function: ${func} (no callers or callees)`,
      suggestion: 'May be dead code or entry point',
    });
  }

  return {
    score,
    problems,
    stats: {
      totalFiles: graph.files.length,
      totalFunctions: graph.stats.totalFunctions,
      unusedExports: unusedExports.length,
      largestFile,
    },
    graphInsights,
  };
}
