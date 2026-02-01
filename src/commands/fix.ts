/**
 * fix command - Autonomous codebase cleanup
 *
 * The "just clean it up" command that:
 * 1. Analyzes the codebase
 * 2. AI decides what to refactor
 * 3. Applies fixes iteratively
 * 4. Validates structure after each change
 */

import chalk from 'chalk';
import ora from 'ora';
import { autoFix, type AutoFixResult } from '../refactor/operations/auto-fix.js';
import { hasGlobalApiKey } from './config.js';

interface FixOptions {
  dryRun?: boolean;
  verbose?: boolean;
  aggressive?: boolean;
  maxIterations?: number;
  skipVerify?: boolean;
  json?: boolean;
  git?: boolean;
  verify?: boolean;
}

export async function fixCommand(options: FixOptions): Promise<void> {
  // Check for AI capability
  if (!hasGlobalApiKey()) {
    console.log(chalk.yellow('\nNote: AI features not configured.'));
    console.log(chalk.gray('Run `consuela config` to enable smarter refactoring decisions.'));
    console.log(chalk.gray('Proceeding with rule-based fixing...\n'));
  }

  const spinner = ora('Starting autonomous fix...').start();

  try {
    let lastAction = '';

    const result = await autoFix({
      dryRun: options.dryRun,
      verbose: options.verbose,
      aggressive: options.aggressive,
      maxIterations: options.maxIterations ?? 10,
      skipVerify: options.skipVerify,
      git: options.git,
      verify: options.verify,
    });

    spinner.stop();

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    printResult(result, options);

  } catch (error) {
    spinner.fail('Fix failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printResult(result: AutoFixResult, options: FixOptions): void {
  const { beforeStats, afterStats, actionsApplied, actionsFailed, iterations } = result;

  console.log(chalk.cyan('\n Fix Complete\n'));
  console.log(chalk.gray('='.repeat(50)));

  // Summary
  console.log(chalk.cyan('\n Results\n'));

  if (options.dryRun) {
    console.log(chalk.yellow('  [DRY RUN - No changes applied]\n'));
  }

  console.log(`  Iterations:      ${iterations}`);
  console.log(`  Actions taken:   ${actionsApplied.length}`);
  console.log(`  Actions failed:  ${actionsFailed.length}`);
  console.log(`  Files modified:  ${result.filesModified.length}`);
  console.log(`  Lines changed:   ${result.linesChanged}`);

  if (result.commitsCreated.length > 0) {
    console.log(`  Git commits:     ${result.commitsCreated.length} (${result.commitsCreated.join(', ')})`);
  }

  // Before/After comparison
  console.log(chalk.cyan('\n Improvement\n'));

  const filesDiff = afterStats.files - beforeStats.files;
  const funcsDiff = afterStats.functions - beforeStats.functions;
  const unusedDiff = afterStats.unusedExports - beforeStats.unusedExports;
  const criticalDiff = afterStats.criticalIssues - beforeStats.criticalIssues;
  const warningsDiff = afterStats.warnings - beforeStats.warnings;

  console.log(`  Files:           ${beforeStats.files} → ${afterStats.files} ${formatDiff(filesDiff)}`);
  console.log(`  Functions:       ${beforeStats.functions} → ${afterStats.functions} ${formatDiff(funcsDiff)}`);
  console.log(`  Unused exports:  ${beforeStats.unusedExports} → ${afterStats.unusedExports} ${formatDiff(unusedDiff)}`);
  console.log(`  Critical issues: ${beforeStats.criticalIssues} → ${afterStats.criticalIssues} ${formatDiff(criticalDiff)}`);
  console.log(`  Warnings:        ${beforeStats.warnings} → ${afterStats.warnings} ${formatDiff(warningsDiff)}`);

  // Actions taken
  if (actionsApplied.length > 0) {
    console.log(chalk.cyan('\n Actions Applied\n'));
    for (const action of actionsApplied) {
      const icon = action.type === 'cleanup' ? '[cleanup]' :
                   action.type === 'split' ? '[split]' :
                   action.type === 'merge' ? '[merge]' : '[skip]';
      console.log(`  ${icon} ${action.type}: ${action.reason}`);
      if (action.target) {
        console.log(chalk.gray(`     -> ${action.target}`));
      }
    }
  }

  // Failed actions
  if (actionsFailed.length > 0) {
    console.log(chalk.red('\n Actions Failed\n'));
    for (const action of actionsFailed) {
      console.log(chalk.red(`  * ${action.type}: ${action.reason}`));
      console.log(chalk.gray(`    Error: ${action.error}`));
    }
  }

  // Files modified
  if (result.filesModified.length > 0 && result.filesModified.length <= 10) {
    console.log(chalk.cyan('\n Files Modified\n'));
    for (const file of result.filesModified) {
      console.log(chalk.gray(`  - ${file}`));
    }
  }

  // Structure validation
  console.log(chalk.cyan('\n Structure Validation\n'));
  if (result.structureValid) {
    console.log(chalk.green('  [OK] All changes preserve structural integrity'));
  } else {
    console.log(chalk.yellow('  [WARN] Some structural changes detected'));
    console.log(chalk.gray('    Run `consuela verify` for details'));
  }

  // Next steps
  console.log(chalk.gray('\n' + '='.repeat(50)));

  if (afterStats.unusedExports > 0 || afterStats.criticalIssues > 0) {
    console.log(chalk.cyan('\n Remaining Issues\n'));

    if (afterStats.unusedExports > 0) {
      console.log(chalk.gray(`  * ${afterStats.unusedExports} unused exports (may need manual review)`));
    }

    if (afterStats.criticalIssues > 0) {
      console.log(chalk.gray(`  * ${afterStats.criticalIssues} large files (use --aggressive to split)`));
    }

    console.log(chalk.gray('\n  Run `consuela diagnose` for full details.'));
  } else {
    console.log(chalk.green('\n Codebase is clean!'));
  }

  console.log('');
}

function formatDiff(diff: number): string {
  if (diff === 0) return chalk.gray('(no change)');
  if (diff < 0) return chalk.green(`(${diff})`);
  return chalk.red(`(+${diff})`);
}
