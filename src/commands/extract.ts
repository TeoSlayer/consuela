/**
 * extract command - Find and extract pure functions
 * Identifies deterministic, side-effect-free code for safe refactoring
 */

import chalk from 'chalk';
import ora from 'ora';
import { createGraphAnalyzer, type FunctionNode } from '../graph/index.js';

interface ExtractOptions {
  pure?: boolean;
  impure?: boolean;
  json?: boolean;
  file?: string;
}

export async function extractCommand(options: ExtractOptions): Promise<void> {
  // Default to --pure if nothing specified
  if (!options.pure && !options.impure) {
    options.pure = true;
  }

  const spinner = ora('Analyzing function purity...').start();

  try {
    const analyzer = createGraphAnalyzer();
    const graph = await analyzer.buildGraph();

    spinner.succeed('Purity analysis complete');

    let functions: FunctionNode[];

    if (options.pure && options.impure) {
      functions = [...graph.nodes.values()];
    } else if (options.pure) {
      functions = [...graph.nodes.values()].filter(f => f.purity === 'pure');
    } else {
      functions = [...graph.nodes.values()].filter(f => f.purity === 'impure');
    }

    // Filter by file if specified
    if (options.file) {
      functions = functions.filter(f => f.filePath.includes(options.file!));
    }

    if (options.json) {
      console.log(JSON.stringify(functions, null, 2));
      return;
    }

    if (options.pure && !options.impure) {
      printPureFunctions(functions, graph.stats);
    } else if (options.impure && !options.pure) {
      printImpureFunctions(functions, graph.stats);
    } else {
      printAllFunctions(functions, graph.stats);
    }

  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printPureFunctions(functions: FunctionNode[], stats: { totalFunctions: number }): void {
  console.log(chalk.cyan('\n🧪 Pure Functions\n'));
  console.log(chalk.gray('  These functions have no side effects and are safe to refactor.\n'));

  if (functions.length === 0) {
    console.log(chalk.yellow('  No pure functions found.\n'));
    return;
  }

  // Group by file
  const byFile = new Map<string, FunctionNode[]>();
  for (const func of functions) {
    const existing = byFile.get(func.filePath) || [];
    existing.push(func);
    byFile.set(func.filePath, existing);
  }

  for (const [filePath, fileFuncs] of byFile) {
    console.log(chalk.white(`  ${filePath}`));
    for (const func of fileFuncs) {
      const asyncLabel = func.isAsync ? chalk.blue(' async') : '';
      const methodLabel = func.isMethod ? chalk.gray(' (method)') : '';
      console.log(`    ${chalk.green('●')} ${func.name}${asyncLabel}${methodLabel}`);
      if (func.signature) {
        console.log(chalk.gray(`      ${func.signature}`));
      }
    }
    console.log('');
  }

  const pureRatio = (functions.length / stats.totalFunctions * 100).toFixed(1);
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.green(functions.length)} pure functions (${pureRatio}% of codebase)`);
  console.log(chalk.gray('  These can be safely extracted, memoized, or parallelized.\n'));
}

function printImpureFunctions(functions: FunctionNode[], stats: { totalFunctions: number }): void {
  console.log(chalk.cyan('\n⚠ Impure Functions\n'));
  console.log(chalk.gray('  These functions have side effects and need careful refactoring.\n'));

  if (functions.length === 0) {
    console.log(chalk.green('  No impure functions found! 🎉\n'));
    return;
  }

  // Group by file
  const byFile = new Map<string, FunctionNode[]>();
  for (const func of functions) {
    const existing = byFile.get(func.filePath) || [];
    existing.push(func);
    byFile.set(func.filePath, existing);
  }

  for (const [filePath, fileFuncs] of byFile) {
    console.log(chalk.white(`  ${filePath}`));
    for (const func of fileFuncs) {
      console.log(`    ${chalk.red('●')} ${func.name}`);

      // Show impurity reasons
      for (const reason of func.impurityReasons.slice(0, 3)) {
        const icon = getReasonIcon(reason.type);
        console.log(chalk.yellow(`      ${icon} ${reason.description}`));
      }
      if (func.impurityReasons.length > 3) {
        console.log(chalk.gray(`      ... and ${func.impurityReasons.length - 3} more reasons`));
      }
    }
    console.log('');
  }

  const impureRatio = (functions.length / stats.totalFunctions * 100).toFixed(1);
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.red(functions.length)} impure functions (${impureRatio}% of codebase)`);
  console.log(chalk.gray('  Consider isolating these into dedicated "effect" modules.\n'));
}

function printAllFunctions(functions: FunctionNode[], stats: { totalFunctions: number }): void {
  console.log(chalk.cyan('\n📊 All Functions by Purity\n'));

  const pure = functions.filter(f => f.purity === 'pure');
  const impure = functions.filter(f => f.purity === 'impure');

  // Group by file
  const byFile = new Map<string, FunctionNode[]>();
  for (const func of functions) {
    const existing = byFile.get(func.filePath) || [];
    existing.push(func);
    byFile.set(func.filePath, existing);
  }

  for (const [filePath, fileFuncs] of byFile) {
    console.log(chalk.white(`  ${filePath}`));
    for (const func of fileFuncs) {
      const icon = func.purity === 'pure' ? chalk.green('●') : chalk.red('●');
      const label = func.purity === 'pure' ? '' : chalk.gray(' [impure]');
      console.log(`    ${icon} ${func.name}${label}`);
    }
    console.log('');
  }

  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.green(pure.length)} pure | ${chalk.red(impure.length)} impure`);
  console.log('');
}

function getReasonIcon(type: string): string {
  switch (type) {
    case 'io': return '📁';
    case 'global': return '🌐';
    case 'nondeterministic': return '🎲';
    case 'infected': return '🦠';
    case 'external': return '⚡';
    default: return '•';
  }
}
