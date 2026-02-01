import chalk from 'chalk';
import ora from 'ora';
import { createConfiguredAnalyzer, type ProjectAnalysis, type ExportInfo } from '../core/index.js';

interface ExportsOptions {
  json?: boolean;
  file?: string;
  kind?: string;
}

export async function exportsCommand(options: ExportsOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    if (options.json) {
      printJson(analysis, options);
      return;
    }

    printExports(analysis, options);
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printJson(analysis: ProjectAnalysis, options: ExportsOptions): void {
  const exports: ExportInfo[] = [];

  for (const [, fileAnalysis] of analysis.files) {
    if (options.file && !fileAnalysis.filePath.includes(options.file)) continue;

    for (const exp of fileAnalysis.exports) {
      if (options.kind && exp.kind !== options.kind) continue;
      exports.push(exp);
    }
  }

  console.log(JSON.stringify(exports, null, 2));
}

function printExports(analysis: ProjectAnalysis, options: ExportsOptions): void {
  console.log(chalk.cyan('\n📦 Exports\n'));

  const byFile = new Map<string, ExportInfo[]>();

  for (const [, fileAnalysis] of analysis.files) {
    if (options.file && !fileAnalysis.filePath.includes(options.file)) continue;
    if (fileAnalysis.exports.length === 0) continue;

    const filtered = options.kind
      ? fileAnalysis.exports.filter((e) => e.kind === options.kind)
      : fileAnalysis.exports;

    if (filtered.length > 0) {
      byFile.set(fileAnalysis.filePath, filtered);
    }
  }

  if (byFile.size === 0) {
    console.log(chalk.gray('  No exports found matching criteria.\n'));
    return;
  }

  for (const [filePath, exports] of byFile) {
    console.log(chalk.white(`  ${filePath}`));

    for (const exp of exports) {
      const kindColor = getKindColor(exp.kind);
      const kindLabel = chalk[kindColor](`[${exp.kind}]`);
      const defaultLabel = exp.isDefault ? chalk.gray(' (default)') : '';
      const sigLabel = exp.signature ? chalk.gray(` ${exp.signature}`) : '';

      console.log(`    ${kindLabel} ${chalk.green(exp.name)}${defaultLabel}${sigLabel}`);
    }
    console.log('');
  }

  // Summary
  const total = Array.from(byFile.values()).flat().length;
  const byKind = new Map<string, number>();
  for (const exports of byFile.values()) {
    for (const exp of exports) {
      byKind.set(exp.kind, (byKind.get(exp.kind) || 0) + 1);
    }
  }

  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  Total: ${chalk.white(total)} exports in ${chalk.white(byFile.size)} files`);
  for (const [kind, count] of byKind) {
    console.log(`    ${kind}: ${count}`);
  }
  console.log('');
}

function getKindColor(kind: string): 'blue' | 'magenta' | 'yellow' | 'cyan' | 'green' | 'white' {
  switch (kind) {
    case 'function': return 'blue';
    case 'class': return 'magenta';
    case 'interface': return 'cyan';
    case 'type': return 'cyan';
    case 'const': return 'yellow';
    case 'variable': return 'yellow';
    case 'enum': return 'green';
    default: return 'white';
  }
}
