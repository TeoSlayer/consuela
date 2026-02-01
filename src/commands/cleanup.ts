/**
 * cleanup command - Remove dead code from the codebase
 *
 * Usage:
 *   consuela cleanup --unused      # Remove unused exports
 *   consuela cleanup --duplicates  # Consolidate duplicate functions
 *   consuela cleanup --all         # Everything
 *   consuela cleanup --dry-run     # Show what would be removed
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import {
  cleanup,
  generateDiffPreview,
  type CleanupOptions,
  type CleanupResult,
} from '../refactor/operations/cleanup.js';
import type { CleanupCommandOptions } from '../refactor/types.js';

export async function cleanupCommand(options: CleanupCommandOptions): Promise<void> {
  // Determine what to clean
  const cleanupOptions: CleanupOptions = {
    removeUnused: options.unused || options.all,
    removeDuplicates: options.duplicates || options.all,
    removeEmptyFiles: options.unused || options.all,
    dryRun: true, // Always start with dry run to show preview
    rootDir: process.cwd(),
  };

  // Validate options
  if (!cleanupOptions.removeUnused && !cleanupOptions.removeDuplicates) {
    console.log(chalk.yellow('\nNo cleanup action specified.'));
    console.log(chalk.gray('Use --unused, --duplicates, or --all to specify what to clean.\n'));
    console.log(chalk.gray('Examples:'));
    console.log(chalk.gray('  consuela cleanup --unused      # Remove unused exports'));
    console.log(chalk.gray('  consuela cleanup --duplicates  # Consolidate duplicates'));
    console.log(chalk.gray('  consuela cleanup --all         # Everything'));
    console.log('');
    process.exit(1);
  }

  const spinner = ora('Analyzing codebase for dead code...').start();

  try {
    // First pass: dry run to show what would be removed
    const result = await cleanup(cleanupOptions);

    spinner.succeed('Analysis complete');

    // Check if there's anything to do
    if (
      result.removedExports.length === 0 &&
      result.removedFiles.length === 0 &&
      result.consolidatedDuplicates.length === 0
    ) {
      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          message: 'No dead code found',
          removedExports: [],
          removedFiles: [],
          consolidatedDuplicates: [],
        }, null, 2));
      } else {
        console.log(chalk.green('\n  No dead code found! Your codebase is clean.\n'));
      }
      return;
    }

    // Show preview
    if (options.json) {
      console.log(JSON.stringify({
        dryRun: true,
        removedExports: result.removedExports,
        removedFiles: result.removedFiles,
        consolidatedDuplicates: result.consolidatedDuplicates,
        errors: result.errors,
      }, null, 2));

      if (options.dryRun) {
        return;
      }
    } else {
      printPreview(result);
    }

    // If dry run only, we're done
    if (options.dryRun) {
      console.log(chalk.gray('\n  Dry run - no changes made.'));
      console.log(chalk.gray('  Run without --dry-run to apply changes.\n'));
      return;
    }

    // Ask for confirmation unless --yes flag is provided
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: chalk.yellow(`Remove ${result.removedExports.length} export(s) and ${result.removedFiles.length} file(s)?`),
          default: false,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('\n  Cleanup cancelled.\n'));
        return;
      }
    }

    // Apply changes
    spinner.start('Removing dead code...');

    const finalResult = await cleanup({
      ...cleanupOptions,
      dryRun: false,
    });

    if (finalResult.success) {
      spinner.succeed('Cleanup complete');
      printSummary(finalResult);
    } else {
      spinner.fail('Cleanup failed');
      for (const error of finalResult.errors) {
        console.log(chalk.red(`  Error: ${error}`));
      }
      process.exit(1);
    }

  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`\nError: ${error}\n`));
    process.exit(1);
  }
}

/**
 * Print a preview of what will be removed
 */
function printPreview(result: CleanupResult): void {
  console.log(chalk.cyan('\n  Dead Code Found\n'));

  // Removed exports by file
  if (result.removedExports.length > 0) {
    console.log(chalk.red(`  Unused exports to remove (${result.removedExports.length}):\n`));

    // Group by file
    const byFile = new Map<string, typeof result.removedExports>();
    for (const exp of result.removedExports) {
      const existing = byFile.get(exp.file) || [];
      existing.push(exp);
      byFile.set(exp.file, existing);
    }

    for (const [file, exports] of byFile) {
      console.log(`    ${chalk.white(file)}`);
      for (const exp of exports) {
        const kindLabel = chalk.gray(`[${exp.kind}]`);
        console.log(`      ${chalk.red('-')} ${kindLabel} ${exp.name} ${chalk.gray(`(line ${exp.line})`)}`);
        if (exp.reason && !exp.reason.includes('Entry point')) {
          console.log(chalk.gray(`        ${exp.reason}`));
        }
      }
    }
    console.log('');
  }

  // Empty files to delete
  if (result.removedFiles.length > 0) {
    console.log(chalk.red(`  Empty files to delete (${result.removedFiles.length}):\n`));
    for (const file of result.removedFiles) {
      console.log(`    ${chalk.red('-')} ${file}`);
    }
    console.log('');
  }

  // Duplicates to consolidate
  if (result.consolidatedDuplicates.length > 0) {
    console.log(chalk.yellow(`  Duplicate functions to consolidate (${result.consolidatedDuplicates.length}):\n`));
    for (const dup of result.consolidatedDuplicates) {
      console.log(`    ${chalk.white(dup.name)}`);
      console.log(`      ${chalk.green('Keep:')} ${dup.kept}`);
      for (const removed of dup.removed) {
        console.log(`      ${chalk.red('Remove:')} ${removed}`);
      }
    }
    console.log('');
  }

  // Show file diffs
  if (result.fileChanges.size > 0 && result.fileChanges.size <= 5) {
    console.log(chalk.cyan('  Preview of changes:\n'));
    console.log(chalk.gray('─'.repeat(50)));

    for (const [, change] of result.fileChanges) {
      const diff = generateDiffPreview(change);
      const lines = diff.split('\n');
      for (const line of lines) {
        if (line.startsWith('-') && !line.startsWith('---')) {
          console.log(chalk.red(`  ${line}`));
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          console.log(chalk.green(`  ${line}`));
        } else {
          console.log(chalk.gray(`  ${line}`));
        }
      }
      console.log('');
    }
  } else if (result.fileChanges.size > 5) {
    console.log(chalk.gray(`  (${result.fileChanges.size} files will be modified - too many to preview)\n`));
  }

  // Warnings
  if (result.errors.length > 0) {
    console.log(chalk.yellow('  Warnings:\n'));
    for (const error of result.errors) {
      console.log(`    ${chalk.yellow('!')} ${error}`);
    }
    console.log('');
  }

  // Summary line
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  Total: ${chalk.red(result.removedExports.length)} exports, ${chalk.red(result.removedFiles.length)} files`);
  console.log('');
}

/**
 * Print summary after cleanup is complete
 */
function printSummary(result: CleanupResult): void {
  console.log(chalk.green('\n  Cleanup Summary\n'));

  if (result.removedExports.length > 0) {
    console.log(`    ${chalk.green('Removed')} ${result.removedExports.length} unused export(s)`);
  }

  if (result.removedFiles.length > 0) {
    console.log(`    ${chalk.green('Deleted')} ${result.removedFiles.length} empty file(s)`);
    for (const file of result.removedFiles) {
      console.log(chalk.gray(`      - ${file}`));
    }
  }

  if (result.consolidatedDuplicates.length > 0) {
    console.log(`    ${chalk.green('Consolidated')} ${result.consolidatedDuplicates.length} duplicate(s)`);
  }

  console.log('');
  console.log(chalk.gray('  Tip: Run `consuela verify` to ensure no structural changes.\n'));
}