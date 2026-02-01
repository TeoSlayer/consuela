import chalk from 'chalk';
import ora from 'ora';
import { createConfiguredAnalyzer } from '../core/index.js';

interface CircularOptions {
  json?: boolean;
  fail?: boolean;
}

export async function circularCommand(options: CircularOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    const cycles = analysis.circularDependencies;

    if (options.json) {
      console.log(JSON.stringify({
        count: cycles.length,
        cycles: cycles.map(cycle => ({
          files: cycle,
          chain: cycle.join(' → ') + ' → ' + cycle[0],
        })),
      }, null, 2));

      if (options.fail && cycles.length > 0) {
        process.exit(1);
      }
      return;
    }

    printCircular(cycles);

    if (options.fail && cycles.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printCircular(cycles: string[][]): void {
  console.log(chalk.cyan('\n🔄 Circular Dependencies\n'));
  console.log(chalk.gray('─'.repeat(50)));

  if (cycles.length === 0) {
    console.log(chalk.green('\n  ✓ No circular dependencies found!\n'));
    return;
  }

  console.log(chalk.yellow(`\n  Found ${cycles.length} circular dependency chains:\n`));

  // Group by size
  const small = cycles.filter(c => c.length <= 2);
  const medium = cycles.filter(c => c.length > 2 && c.length <= 5);
  const large = cycles.filter(c => c.length > 5);

  if (small.length > 0) {
    console.log(chalk.white('  Direct cycles (2 files):'));
    for (const cycle of small.slice(0, 10)) {
      console.log(`    ${chalk.yellow('↻')} ${cycle.join(' ↔ ')}`);
    }
    if (small.length > 10) {
      console.log(chalk.gray(`    ... and ${small.length - 10} more`));
    }
    console.log('');
  }

  if (medium.length > 0) {
    console.log(chalk.white('  Medium cycles (3-5 files):'));
    for (const cycle of medium.slice(0, 5)) {
      console.log(`    ${chalk.yellow('↻')} ${cycle.join(' → ')} → ${cycle[0]}`);
    }
    if (medium.length > 5) {
      console.log(chalk.gray(`    ... and ${medium.length - 5} more`));
    }
    console.log('');
  }

  if (large.length > 0) {
    console.log(chalk.white('  Large cycles (6+ files):'));
    for (const cycle of large.slice(0, 3)) {
      console.log(`    ${chalk.yellow('↻')} ${cycle.slice(0, 3).join(' → ')} → ... (${cycle.length} files)`);
    }
    if (large.length > 3) {
      console.log(chalk.gray(`    ... and ${large.length - 3} more`));
    }
    console.log('');
  }

  // Find most problematic files
  const fileAppearances = new Map<string, number>();
  for (const cycle of cycles) {
    for (const file of cycle) {
      fileAppearances.set(file, (fileAppearances.get(file) || 0) + 1);
    }
  }

  const hotspots = Array.from(fileAppearances.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (hotspots.length > 0 && hotspots[0][1] > 1) {
    console.log(chalk.white('  Hotspots (files in multiple cycles):'));
    for (const [file, count] of hotspots) {
      if (count > 1) {
        console.log(`    ${chalk.red('!')} ${file} ${chalk.gray(`(in ${count} cycles)`)}`);
      }
    }
    console.log('');
  }

  // Summary
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.white('\n  Summary:'));
  console.log(`    Total cycles:     ${chalk.yellow(cycles.length)}`);
  console.log(`    Direct (2-file):  ${small.length}`);
  console.log(`    Medium (3-5):     ${medium.length}`);
  console.log(`    Large (6+):       ${large.length}`);

  console.log(chalk.white('\n  How to fix:'));
  console.log(chalk.gray('    1. Identify shared code and extract to a separate module'));
  console.log(chalk.gray('    2. Use dependency injection instead of direct imports'));
  console.log(chalk.gray('    3. Consider lazy imports for runtime-only dependencies'));
  console.log(chalk.gray('    4. Use `consuela impact <file>` to understand dependencies\n'));
}
