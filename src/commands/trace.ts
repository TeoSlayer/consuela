import chalk from 'chalk';
import ora from 'ora';
import { createConfiguredAnalyzer, type SymbolTrace } from '../core/index.js';

interface TraceOptions {
  json?: boolean;
}

export async function traceCommand(symbol: string, options: TraceOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    // Find the symbol - could be "file:name" or just "name"
    let trace: SymbolTrace | undefined;
    let matchedKey: string | undefined;

    if (symbol.includes(':')) {
      trace = analysis.symbolTraces.get(symbol);
      matchedKey = symbol;
    } else {
      // Search by name
      const matches: Array<{ key: string; trace: SymbolTrace }> = [];
      for (const [key, t] of analysis.symbolTraces) {
        if (t.symbol.name === symbol) {
          matches.push({ key, trace: t });
        }
      }

      if (matches.length === 0) {
        console.log(chalk.red(`\nNo export found with name "${symbol}"\n`));
        process.exit(1);
      }

      if (matches.length > 1) {
        console.log(chalk.yellow(`\nMultiple exports found with name "${symbol}":\n`));
        for (const { key, trace: t } of matches) {
          console.log(`  ${chalk.gray(key)} - ${t.symbol.kind} at line ${t.symbol.line}`);
        }
        console.log(chalk.gray(`\nSpecify the full path: consuela trace "file:${symbol}"\n`));
        process.exit(1);
      }

      trace = matches[0].trace;
      matchedKey = matches[0].key;
    }

    if (!trace) {
      console.log(chalk.red(`\nExport "${symbol}" not found\n`));
      process.exit(1);
    }

    if (options.json) {
      console.log(JSON.stringify({
        key: matchedKey,
        symbol: trace.symbol,
        importedBy: trace.importedBy,
        usages: trace.usages,
        dependents: trace.dependents,
        usageCount: trace.usageCount,
      }, null, 2));
      return;
    }

    printTrace(matchedKey!, trace);
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printTrace(key: string, trace: SymbolTrace): void {
  const { symbol, importedBy, usages, dependents } = trace;

  console.log(chalk.cyan(`\n🔍 Trace: ${key}\n`));
  console.log(chalk.gray('─'.repeat(50)));

  // Symbol info
  console.log(chalk.white('\n  Definition:'));
  console.log(`    File:      ${chalk.green(symbol.filePath)}`);
  console.log(`    Line:      ${symbol.line}`);
  console.log(`    Kind:      ${symbol.kind}`);
  console.log(`    Default:   ${symbol.isDefault ? 'yes' : 'no'}`);
  if (symbol.signature) {
    console.log(`    Signature: ${chalk.gray(symbol.signature)}`);
  }

  // Imported by
  console.log(chalk.white(`\n  Imported by (${importedBy.length}):`));
  if (importedBy.length === 0) {
    console.log(chalk.gray('    Not imported by any file'));
  } else {
    for (const imp of importedBy) {
      const alias = imp.alias ? chalk.gray(` as ${imp.alias}`) : '';
      console.log(`    ${chalk.blue(imp.file)}:${imp.line}${alias}`);
    }
  }

  // Usages
  console.log(chalk.white(`\n  Usages (${usages.length}):`));
  if (usages.length === 0) {
    console.log(chalk.gray('    No usages found'));
  } else {
    // Group by file
    const byFile = new Map<string, typeof usages>();
    for (const usage of usages) {
      const existing = byFile.get(usage.filePath) || [];
      existing.push(usage);
      byFile.set(usage.filePath, existing);
    }

    for (const [file, fileUsages] of byFile) {
      console.log(`    ${chalk.blue(file)}`);
      for (const usage of fileUsages.slice(0, 5)) {
        const typeColor = getUsageTypeColor(usage.usageType);
        console.log(`      ${chalk.gray(`L${usage.line}`)} ${chalk[typeColor](`[${usage.usageType}]`)} ${chalk.gray(truncate(usage.context, 50))}`);
      }
      if (fileUsages.length > 5) {
        console.log(chalk.gray(`      ... and ${fileUsages.length - 5} more usages`));
      }
    }
  }

  // Impact (dependents)
  console.log(chalk.white(`\n  Impact (${dependents.length} files affected if changed):`));
  if (dependents.length === 0) {
    console.log(chalk.gray('    No dependents - safe to modify'));
  } else {
    for (const dep of dependents.slice(0, 10)) {
      console.log(`    ${chalk.yellow(dep)}`);
    }
    if (dependents.length > 10) {
      console.log(chalk.gray(`    ... and ${dependents.length - 10} more files`));
    }
  }

  // Summary
  console.log(chalk.gray('\n' + '─'.repeat(50)));
  if (importedBy.length === 0 && usages.length === 0) {
    console.log(chalk.yellow('  ⚠ This export appears to be unused'));
  } else if (dependents.length > 5) {
    console.log(chalk.red(`  ⚠ High impact: ${dependents.length} files depend on this`));
  } else {
    console.log(chalk.green(`  ✓ Used ${usages.length} times across ${importedBy.length} files`));
  }
  console.log('');
}

function getUsageTypeColor(type: string): 'green' | 'blue' | 'magenta' | 'yellow' | 'cyan' | 'white' {
  switch (type) {
    case 'call': return 'green';
    case 'extend': return 'magenta';
    case 'implement': return 'magenta';
    case 'spread': return 'yellow';
    case 'assign': return 'blue';
    case 'pass': return 'cyan';
    case 'return': return 'cyan';
    default: return 'white';
  }
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len - 3) + '...';
}
