/**
 * diagnose command - Identify problems in a messy codebase
 * This is the "doctor" that tells you what's wrong before we fix it
 */

import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConfiguredAnalyzer, type ProjectAnalysis, type ProjectAnalyzer } from '../core/index.js';
import { createGraphAnalyzer, type FunctionGraph } from '../graph/index.js';

interface DiagnoseOptions {
  json?: boolean;
}

interface Problem {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  file?: string;
  message: string;
  suggestion?: string;
}

interface DiagnosisResult {
  score: number;
  problems: Problem[];
  stats: {
    totalFiles: number;
    totalFunctions: number;
    totalExports: number;
    unusedExports: number;
    pureRatio: number;
    avgFileSize: number;
    largestFile: { path: string; lines: number };
    duplicateSignatures: number;
    circularDeps: number;
  };
}

export async function diagnoseCommand(options: DiagnoseOptions): Promise<void> {
  const spinner = ora('Analyzing codebase health...').start();

  try {
    // Run both analyzers
    const analyzer = createConfiguredAnalyzer();
    const graphAnalyzer = createGraphAnalyzer();

    const [analysis, graph] = await Promise.all([
      analyzer.analyze(),
      graphAnalyzer.buildGraph(),
    ]);

    spinner.text = 'Identifying problems...';

    const diagnosis = runDiagnosis(analyzer, analysis, graph);

    spinner.succeed('Diagnosis complete');

    if (options.json) {
      console.log(JSON.stringify(diagnosis, null, 2));
      return;
    }

    printDiagnosis(diagnosis);

  } catch (error) {
    spinner.fail('Diagnosis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function runDiagnosis(analyzer: ProjectAnalyzer, analysis: ProjectAnalysis, graph: FunctionGraph): DiagnosisResult {
  const problems: Problem[] = [];

  // Collect file stats
  const fileSizes = new Map<string, number>();
  const functionsByFile = new Map<string, number>();

  for (const file of graph.files) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      const lines = content.split('\n').length;
      fileSizes.set(file, lines);
    } catch {
      fileSizes.set(file, 0);
    }
  }

  for (const func of graph.nodes.values()) {
    const count = functionsByFile.get(func.filePath) || 0;
    functionsByFile.set(func.filePath, count + 1);
  }

  // Find largest file
  let largestFile = { path: '', lines: 0 };
  for (const [file, lines] of fileSizes) {
    if (lines > largestFile.lines) {
      largestFile = { path: file, lines };
    }
  }

  // Problem 1: Large files
  for (const [file, lines] of fileSizes) {
    if (lines > 500) {
      problems.push({
        severity: 'critical',
        category: 'file-size',
        file,
        message: `${lines} lines (recommended: <200)`,
        suggestion: 'Split into smaller, focused modules',
      });
    } else if (lines > 300) {
      problems.push({
        severity: 'warning',
        category: 'file-size',
        file,
        message: `${lines} lines (getting large)`,
        suggestion: 'Consider extracting some functions',
      });
    }
  }

  // Problem 2: Too many functions in one file
  for (const [file, count] of functionsByFile) {
    if (count > 20) {
      problems.push({
        severity: 'critical',
        category: 'complexity',
        file,
        message: `${count} functions in one file`,
        suggestion: 'Split into multiple modules by responsibility',
      });
    } else if (count > 10) {
      problems.push({
        severity: 'warning',
        category: 'complexity',
        file,
        message: `${count} functions (getting complex)`,
        suggestion: 'Consider grouping related functions',
      });
    }
  }

  // Problem 3: Unused exports (use the same logic as findUnusedExports for consistency)
  const unusedExports = analyzer.findUnusedExports(analysis)
    .filter(u => !u.reason.includes('Entry point'));

  for (const unused of unusedExports) {
    problems.push({
      severity: 'warning',
      category: 'dead-code',
      file: unused.export.filePath,
      message: `Unused export: ${unused.export.name}`,
      suggestion: 'Remove if not needed, or check if it should be an entry point',
    });
  }
  const unusedCount = unusedExports.length;

  // Problem 4: Duplicate function signatures
  const signatures = new Map<string, string[]>();
  for (const func of graph.nodes.values()) {
    if (func.signature && func.isExported) {
      const sig = `${func.name}${func.signature}`;
      const existing = signatures.get(sig) || [];
      existing.push(func.filePath);
      signatures.set(sig, existing);
    }
  }

  let duplicateCount = 0;
  for (const [sig, files] of signatures) {
    if (files.length > 1) {
      duplicateCount++;
      const funcName = sig.split('(')[0];
      problems.push({
        severity: 'warning',
        category: 'duplication',
        message: `"${funcName}" has same signature in ${files.length} files`,
        suggestion: `Consolidate into one location: ${files.join(', ')}`,
      });
    }
  }

  // Problem 5: Circular dependencies
  if (analysis.circularDependencies.length > 0) {
    for (const cycle of analysis.circularDependencies) {
      problems.push({
        severity: 'critical',
        category: 'architecture',
        message: `Circular dependency: ${cycle.join(' → ')}`,
        suggestion: 'Extract shared code to break the cycle',
      });
    }
  }

  // Problem 6: Low purity ratio
  const pureRatio = graph.stats.pureFunctions / graph.stats.totalFunctions;
  if (pureRatio < 0.3) {
    problems.push({
      severity: 'warning',
      category: 'architecture',
      message: `Only ${(pureRatio * 100).toFixed(0)}% of functions are pure`,
      suggestion: 'Extract pure logic from side-effect code',
    });
  }

  // Problem 7: God files (files that everything depends on)
  for (const [file, dependents] of analysis.reverseGraph) {
    const depCount = dependents.size;
    if (depCount > 10) {
      problems.push({
        severity: 'warning',
        category: 'architecture',
        file,
        message: `${depCount} files depend on this (potential bottleneck)`,
        suggestion: 'Consider splitting into smaller, focused modules',
      });
    }
  }

  // Calculate health score (0-100) using category-based scoring with diminishing returns
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

  // Calculate stats
  const totalLines = Array.from(fileSizes.values()).reduce((a, b) => a + b, 0);
  const avgFileSize = Math.round(totalLines / fileSizes.size);

  return {
    score,
    problems,
    stats: {
      totalFiles: graph.files.length,
      totalFunctions: graph.stats.totalFunctions,
      totalExports: graph.stats.exportedFunctions,
      unusedExports: unusedCount,
      pureRatio: Math.round(pureRatio * 100),
      avgFileSize,
      largestFile,
      duplicateSignatures: duplicateCount,
      circularDeps: analysis.circularDependencies.length,
    },
  };
}

function printDiagnosis(diagnosis: DiagnosisResult): void {
  const { score, problems, stats } = diagnosis;

  // Health score with color
  let scoreColor: 'green' | 'yellow' | 'red';
  let scoreLabel: string;
  if (score >= 80) {
    scoreColor = 'green';
    scoreLabel = 'Healthy';
  } else if (score >= 50) {
    scoreColor = 'yellow';
    scoreLabel = 'Needs Work';
  } else {
    scoreColor = 'red';
    scoreLabel = 'Critical';
  }

  console.log(chalk.cyan('\n🏥 Codebase Health Report\n'));
  console.log(chalk.gray('═'.repeat(50)));

  // Score display
  console.log(`\n  Health Score: ${chalk[scoreColor].bold(`${score}/100`)} (${scoreLabel})`);

  // Stats
  console.log(chalk.cyan('\n📊 Overview\n'));
  console.log(`  Files:           ${stats.totalFiles}`);
  console.log(`  Functions:       ${stats.totalFunctions}`);
  console.log(`  Exports:         ${stats.totalExports}`);
  console.log(`  Pure functions:  ${stats.pureRatio}%`);
  console.log(`  Avg file size:   ${stats.avgFileSize} lines`);
  console.log(`  Largest file:    ${stats.largestFile.path} (${stats.largestFile.lines} lines)`);

  // Problem summary
  const critical = problems.filter(p => p.severity === 'critical');
  const warnings = problems.filter(p => p.severity === 'warning');

  console.log(chalk.cyan('\n🚨 Issues Found\n'));
  console.log(`  ${chalk.red(`Critical: ${critical.length}`)}`);
  console.log(`  ${chalk.yellow(`Warnings: ${warnings.length}`)}`);

  // Critical problems
  if (critical.length > 0) {
    console.log(chalk.red('\n━━━ Critical Issues ━━━\n'));
    for (const problem of critical.slice(0, 10)) {
      const fileLabel = problem.file ? chalk.gray(`[${problem.file}]`) : '';
      console.log(`  ${chalk.red('✗')} ${fileLabel} ${problem.message}`);
      if (problem.suggestion) {
        console.log(chalk.gray(`    → ${problem.suggestion}`));
      }
    }
    if (critical.length > 10) {
      console.log(chalk.gray(`\n    ... and ${critical.length - 10} more critical issues`));
    }
  }

  // Warnings (grouped by category)
  if (warnings.length > 0) {
    console.log(chalk.yellow('\n━━━ Warnings ━━━\n'));

    const byCategory = new Map<string, Problem[]>();
    for (const problem of warnings) {
      const existing = byCategory.get(problem.category) || [];
      existing.push(problem);
      byCategory.set(problem.category, existing);
    }

    for (const [category, categoryProblems] of byCategory) {
      console.log(chalk.yellow(`  ${getCategoryLabel(category)} (${categoryProblems.length}):`));
      for (const problem of categoryProblems.slice(0, 5)) {
        const fileLabel = problem.file ? chalk.gray(`${problem.file}: `) : '';
        console.log(`    • ${fileLabel}${problem.message}`);
      }
      if (categoryProblems.length > 5) {
        console.log(chalk.gray(`      ... and ${categoryProblems.length - 5} more`));
      }
      console.log('');
    }
  }

  // Recommendations
  console.log(chalk.cyan('━━━ Recommended Actions ━━━\n'));

  const hasQuickFixes = stats.unusedExports > 0;
  const hasDeepFixes = stats.largestFile.lines > 300 || stats.duplicateSignatures > 0;

  if (hasQuickFixes) {
    console.log(`  1. ${chalk.white('Quick fix')} - Remove dead code automatically`);
    console.log(chalk.green(`     Run: consuela fix`));
    console.log('');
  }

  if (hasDeepFixes) {
    console.log(`  2. ${chalk.white('Deep fix')} - AI-powered cleanup (split files, consolidate)`);
    console.log(chalk.green(`     Run: consuela fix --deep`));
    if (stats.largestFile.lines > 300) {
      console.log(chalk.gray(`     Will split: ${stats.largestFile.path} (${stats.largestFile.lines} lines)`));
    }
    console.log('');
  }

  if (stats.circularDeps > 0) {
    console.log(`  3. ${chalk.white('Fix circular dependencies')}`);
    console.log(chalk.green(`     Run: consuela fix --all`));
    console.log(chalk.gray(`     Includes AI-powered restructuring`));
    console.log('');
  }

  // Show the ultimate command if there are multiple issues
  if ((hasQuickFixes || hasDeepFixes) && (stats.circularDeps > 0 || stats.largestFile.lines > 500)) {
    console.log(chalk.gray('═'.repeat(50)));
    console.log(chalk.green.bold('\n  🚀 Fix everything: consuela fix --all\n'));
  } else {
    console.log(chalk.gray('═'.repeat(50)));
    console.log(chalk.green('\n  Quick start: consuela fix\n'));
  }
}

function getCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    'file-size': '📏 Large Files',
    'complexity': '🔀 Complex Files',
    'dead-code': '💀 Dead Code',
    'duplication': '👯 Duplicates',
    'architecture': '🏗️ Architecture',
  };
  return labels[category] || category;
}
