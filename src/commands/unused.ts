import chalk from 'chalk';
import ora from 'ora';
import { createConfiguredAnalyzer, type UnusedExport } from '../core/index.js';

interface UnusedOptions {
  json?: boolean;
  strict?: boolean; // Include entry points
  fail?: boolean; // Exit with code 1 if unused exports found (for CI)
}

export async function unusedCommand(options: UnusedOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    const unused = analyzer.findUnusedExports(analysis);

    // Filter out entry points unless --strict
    const filtered = options.strict
      ? unused
      : unused.filter((u) => !u.reason.includes('Entry point'));

    // Count truly unused for CI
    const trulyUnused = filtered.filter(u => !u.reason.includes('Entry point'));

    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
      if (options.fail && trulyUnused.length > 0) {
        process.exit(1);
      }
      return;
    }

    printUnused(filtered, options.strict);

    if (options.fail && trulyUnused.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printUnused(unused: UnusedExport[], strict?: boolean): void {
  console.log(chalk.cyan('\n🗑️  Unused Exports\n'));

  if (unused.length === 0) {
    console.log(chalk.green('  ✓ No unused exports found!\n'));
    return;
  }

  // Group by file
  const byFile = new Map<string, UnusedExport[]>();
  for (const u of unused) {
    const existing = byFile.get(u.export.filePath) || [];
    existing.push(u);
    byFile.set(u.export.filePath, existing);
  }

  // Separate truly unused from entry points
  const trulyUnused: UnusedExport[] = [];
  const entryPoints: UnusedExport[] = [];

  for (const u of unused) {
    if (u.reason.includes('Entry point')) {
      entryPoints.push(u);
    } else {
      trulyUnused.push(u);
    }
  }

  if (trulyUnused.length > 0) {
    console.log(chalk.red(`  Definitely unused (${trulyUnused.length}):\n`));

    const trulyByFile = new Map<string, UnusedExport[]>();
    for (const u of trulyUnused) {
      const existing = trulyByFile.get(u.export.filePath) || [];
      existing.push(u);
      trulyByFile.set(u.export.filePath, existing);
    }

    for (const [file, exports] of trulyByFile) {
      console.log(`    ${chalk.white(file)}`);
      for (const u of exports) {
        const kindLabel = chalk.gray(`[${u.export.kind}]`);
        console.log(`      ${chalk.red('✗')} ${kindLabel} ${u.export.name}`);
        console.log(chalk.gray(`        ${u.reason}`));
      }
    }
    console.log('');
  }

  if (entryPoints.length > 0 && strict) {
    console.log(chalk.yellow(`  Entry points (${entryPoints.length}) - may be used externally:\n`));

    const entryByFile = new Map<string, UnusedExport[]>();
    for (const u of entryPoints) {
      const existing = entryByFile.get(u.export.filePath) || [];
      existing.push(u);
      entryByFile.set(u.export.filePath, existing);
    }

    for (const [file, exports] of entryByFile) {
      console.log(`    ${chalk.white(file)}`);
      for (const u of exports) {
        const kindLabel = chalk.gray(`[${u.export.kind}]`);
        console.log(`      ${chalk.yellow('?')} ${kindLabel} ${u.export.name}`);
      }
    }
    console.log('');
  }

  // Summary
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  Total: ${chalk.white(unused.length)} potentially unused exports`);
  console.log(`    Definitely unused: ${chalk.red(trulyUnused.length)}`);
  if (!strict && entryPoints.length > 0) {
    console.log(`    Entry points (hidden): ${chalk.yellow(entryPoints.length)} - use --strict to show`);
  }
  console.log('');

  if (trulyUnused.length > 0) {
    console.log(chalk.gray('  Tip: Use `consuela trace <name>` to verify before removing\n'));
  }
}
