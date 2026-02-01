/**
 * verify command - Compare current code against the Gold Standard
 * Ensures AI refactoring hasn't broken the structural skeleton
 */

import chalk from 'chalk';
import ora from 'ora';
import { createGraphAnalyzer, type GraphDiff } from '../graph/index.js';

interface VerifyOptions {
  json?: boolean;
  fail?: boolean;
}

export async function verifyCommand(options: VerifyOptions): Promise<void> {
  const spinner = ora('Verifying structural integrity...').start();

  try {
    const analyzer = createGraphAnalyzer();

    let result;
    try {
      result = await analyzer.verify();
    } catch (error) {
      spinner.fail('Verification failed');
      if (error instanceof Error && error.message.includes('No Gold Standard')) {
        console.log(chalk.yellow('\n⚠ No Gold Standard found.'));
        console.log(chalk.gray('  Run `consuela scan` first to establish the baseline.\n'));
        process.exit(1);
      }
      throw error;
    }

    if (result.valid) {
      spinner.succeed('Structural integrity verified');

      if (options.json) {
        console.log(JSON.stringify({ valid: true, changes: [] }, null, 2));
        return;
      }

      console.log(chalk.green('\n✓ No structural changes detected'));
      console.log(chalk.gray('  The codebase matches the Gold Standard graph.\n'));
      return;
    }

    spinner.warn('Structural changes detected');

    if (options.json) {
      console.log(JSON.stringify({
        valid: false,
        changes: result.diff.summary,
        details: {
          addedFunctions: result.diff.addedFunctions,
          removedFunctions: result.diff.removedFunctions,
          signatureChanges: result.diff.signatureChanges,
          addedEdges: result.diff.addedEdges.length,
          removedEdges: result.diff.removedEdges.length,
          purityChanges: result.diff.purityChanges,
        },
      }, null, 2));

      if (options.fail) {
        process.exit(1);
      }
      return;
    }

    printDiff(result.diff);

    if (options.fail) {
      process.exit(1);
    }

  } catch (error) {
    spinner.fail('Verification failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printDiff(diff: GraphDiff): void {
  console.log(chalk.yellow('\n⚠ Structural Changes Detected\n'));
  console.log(chalk.gray('─'.repeat(50)));

  if (diff.addedFunctions.length > 0) {
    console.log(chalk.cyan('\n  Added Functions:'));
    for (const fn of diff.addedFunctions.slice(0, 10)) {
      console.log(chalk.green(`    + ${fn}`));
    }
    if (diff.addedFunctions.length > 10) {
      console.log(chalk.gray(`    ... and ${diff.addedFunctions.length - 10} more`));
    }
  }

  if (diff.removedFunctions.length > 0) {
    console.log(chalk.cyan('\n  Removed Functions:'));
    for (const fn of diff.removedFunctions.slice(0, 10)) {
      console.log(chalk.red(`    - ${fn}`));
    }
    if (diff.removedFunctions.length > 10) {
      console.log(chalk.gray(`    ... and ${diff.removedFunctions.length - 10} more`));
    }
  }

  if (diff.signatureChanges.length > 0) {
    console.log(chalk.cyan('\n  Signature Changes:'));
    for (const change of diff.signatureChanges.slice(0, 5)) {
      console.log(chalk.yellow(`    ~ ${change.id}`));
      console.log(chalk.red(`      - ${change.oldSignature}`));
      console.log(chalk.green(`      + ${change.newSignature}`));
    }
    if (diff.signatureChanges.length > 5) {
      console.log(chalk.gray(`    ... and ${diff.signatureChanges.length - 5} more`));
    }
  }

  if (diff.addedEdges.length > 0 || diff.removedEdges.length > 0) {
    console.log(chalk.cyan('\n  Call Graph Changes:'));
    if (diff.addedEdges.length > 0) {
      console.log(chalk.green(`    + ${diff.addedEdges.length} new call(s)`));
    }
    if (diff.removedEdges.length > 0) {
      console.log(chalk.red(`    - ${diff.removedEdges.length} removed call(s)`));
    }
  }

  if (diff.purityChanges.length > 0) {
    console.log(chalk.cyan('\n  Purity Changes:'));
    for (const change of diff.purityChanges.slice(0, 5)) {
      const arrow = change.newPurity === 'pure'
        ? chalk.green('→ pure')
        : chalk.red('→ impure');
      console.log(`    ${change.id}: ${change.oldPurity} ${arrow}`);
    }
    if (diff.purityChanges.length > 5) {
      console.log(chalk.gray(`    ... and ${diff.purityChanges.length - 5} more`));
    }
  }

  console.log(chalk.gray('\n─'.repeat(50)));
  console.log(chalk.yellow('\n  Summary:'));
  for (const line of diff.summary) {
    console.log(`    • ${line}`);
  }

  console.log(chalk.gray('\n  If these changes are intentional, run:'));
  console.log(chalk.white('    consuela scan'));
  console.log(chalk.gray('  to update the Gold Standard.\n'));
}
