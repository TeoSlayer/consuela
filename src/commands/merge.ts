import chalk from 'chalk';
import ora from 'ora';
import { glob } from 'glob';
import { mergeFiles, type MergeResult } from '../refactor/operations/merge.js';
import type { MergeCommandOptions } from '../refactor/types.js';

/**
 * Execute the merge command
 */
export async function mergeCommand(
  sourcePatterns: string[],
  options: MergeCommandOptions
): Promise<void> {
  const rootDir = process.cwd();

  // Validate options
  if (!options.into) {
    console.error(chalk.red('\nError: --into <file> is required'));
    console.log(chalk.gray('  Example: consuela merge src/a.ts src/b.ts --into src/combined.ts'));
    process.exit(1);
  }

  if (sourcePatterns.length === 0) {
    console.error(chalk.red('\nError: At least one source file is required'));
    console.log(chalk.gray('  Example: consuela merge src/a.ts src/b.ts --into src/combined.ts'));
    process.exit(1);
  }

  // Expand glob patterns to actual files
  const spinner = ora('Resolving files...').start();
  let sources: string[] = [];

  try {
    for (const pattern of sourcePatterns) {
      if (pattern.includes('*')) {
        const matches = await glob(pattern, {
          cwd: rootDir,
          absolute: false,
          ignore: ['**/node_modules/**', '**/dist/**'],
        });
        sources.push(...matches);
      } else {
        sources.push(pattern);
      }
    }

    // Remove duplicates
    sources = [...new Set(sources)];

    if (sources.length === 0) {
      spinner.fail('No source files found');
      process.exit(1);
    }

    if (sources.length === 1) {
      spinner.fail('Need at least 2 files to merge');
      console.log(chalk.gray(`  Found only: ${sources[0]}`));
      process.exit(1);
    }

    spinner.text = `Merging ${sources.length} files...`;

    // Execute merge
    const result = await mergeFiles({
      sources,
      target: options.into,
      deleteOriginals: !options.keepOriginals,
      dryRun: options.dryRun,
      rootDir,
    });

    spinner.stop();

    // Output results
    if (options.json) {
      printJsonResult(result);
    } else {
      printHumanResult(result, options.dryRun ?? false);
    }

    // Exit with error code if merge failed
    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Merge failed');
    console.error(chalk.red(`\nError: ${error instanceof Error ? error.message : error}`));
    process.exit(1);
  }
}

/**
 * Print result as JSON
 */
function printJsonResult(result: MergeResult): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Print human-readable result
 */
function printHumanResult(result: MergeResult, isDryRun: boolean): void {
  const prefix = isDryRun ? chalk.blue('[DRY RUN] ') : '';

  console.log('');

  if (result.success) {
    console.log(prefix + chalk.green('Merge successful!'));
  } else {
    console.log(prefix + chalk.yellow('Merge completed with warnings'));
  }

  console.log('');

  // Show what was merged
  console.log(chalk.cyan('Files merged:'));
  for (const file of result.mergedFrom) {
    console.log(`  ${chalk.gray('-')} ${file}`);
  }
  console.log('');

  // Show target
  console.log(chalk.cyan('Target file:'));
  console.log(`  ${chalk.green(result.targetFile)}`);
  console.log('');

  // Show import rewrites
  if (result.importsRewritten > 0) {
    console.log(chalk.cyan('Imports updated:'));
    console.log(`  ${chalk.yellow(result.importsRewritten)} import statement${result.importsRewritten !== 1 ? 's' : ''} rewritten`);

    if (result.filesUpdated && result.filesUpdated.length > 0) {
      console.log(chalk.gray('  In files:'));
      for (const file of result.filesUpdated.slice(0, 10)) {
        console.log(`    ${chalk.gray('-')} ${file}`);
      }
      if (result.filesUpdated.length > 10) {
        console.log(chalk.gray(`    ... and ${result.filesUpdated.length - 10} more`));
      }
    }
    console.log('');
  }

  // Show deleted files
  if (result.filesDeleted.length > 0) {
    console.log(chalk.cyan(isDryRun ? 'Files to delete:' : 'Files deleted:'));
    for (const file of result.filesDeleted) {
      console.log(`  ${chalk.red('-')} ${file}`);
    }
    console.log('');
  }

  // Show conflicts if any
  if (result.conflicts && result.conflicts.length > 0) {
    console.log(chalk.yellow('Export conflicts detected:'));
    for (const conflict of result.conflicts) {
      console.log(`  ${chalk.yellow('!')} "${conflict.name}" exported from:`);
      for (const source of conflict.sources) {
        console.log(`      ${chalk.gray('-')} ${source}`);
      }
    }
    console.log(chalk.gray('  Note: First occurrence was used, duplicates were commented out.'));
    console.log('');
  }

  // Show errors if any
  if (result.errors && result.errors.length > 0) {
    console.log(chalk.red('Errors:'));
    for (const error of result.errors) {
      console.log(`  ${chalk.red('!')} ${error}`);
    }
    console.log('');
  }

  // Show preview of changes
  if (isDryRun && result.changes && result.changes.length > 0) {
    console.log(chalk.cyan('Preview of changes:'));
    console.log(chalk.gray('─'.repeat(50)));

    for (const change of result.changes) {
      console.log('');
      console.log(chalk.white(`File: ${change.filePath}`));
      console.log(chalk.gray(`Action: ${change.description}`));

      // Show a snippet of the new content for the target file
      if (change.filePath === result.targetFile && change.newContent) {
        const lines = change.newContent.split('\n');
        const preview = lines.slice(0, 20).join('\n');
        console.log(chalk.gray('─'.repeat(30)));
        console.log(chalk.gray(preview));
        if (lines.length > 20) {
          console.log(chalk.gray(`... (${lines.length - 20} more lines)`));
        }
      }
    }

    console.log('');
    console.log(chalk.gray('─'.repeat(50)));
    console.log(chalk.blue('\nRun without --dry-run to apply these changes.'));
  }

  // Summary
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.white('Summary:'));
  console.log(`  ${chalk.green(result.mergedFrom.length)} files merged`);
  console.log(`  ${chalk.yellow(result.importsRewritten)} imports rewritten`);
  console.log(`  ${chalk.red(result.filesDeleted.length)} files ${isDryRun ? 'to delete' : 'deleted'}`);
}