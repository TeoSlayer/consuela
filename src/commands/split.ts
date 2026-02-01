/**
 * split command - Extract functions from a file into a new file
 * Handles dependency tracking, import updates, and preserves structure
 */

import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import inquirer from 'inquirer';
import { splitFile, previewSplit, type SplitOptions, type SplitResult } from '../refactor/operations/split.js';
import { hasGlobalApiKey } from './config.js';

interface SplitCommandOptions {
  extract?: string;
  functions?: string;
  auto?: boolean;
  dryRun?: boolean;
  json?: boolean;
  yes?: boolean;
}

export async function splitCommand(
  source: string,
  options: SplitCommandOptions
): Promise<void> {
  // Validate options
  if (!options.extract && !options.auto) {
    console.log(chalk.red('\nError: Either --extract <file> or --auto must be specified.\n'));
    console.log(chalk.gray('Usage examples:'));
    console.log(chalk.gray('  consuela split src/big-file.ts --extract src/helpers.ts --functions func1,func2'));
    console.log(chalk.gray('  consuela split src/big-file.ts --auto'));
    process.exit(1);
  }

  if (options.auto && !hasGlobalApiKey()) {
    console.log(chalk.yellow('\nNote: --auto works best with Gemini AI configured.'));
    console.log(chalk.gray('Run `consuela config` to set up AI features for better suggestions.\n'));
    console.log(chalk.gray('Proceeding with heuristic-based extraction...\n'));
  }

  // Parse functions list
  const functionsList = options.functions
    ? options.functions.split(',').map((f) => f.trim()).filter(Boolean)
    : undefined;

  if (!options.auto && (!functionsList || functionsList.length === 0)) {
    console.log(chalk.red('\nError: --functions must be specified when not using --auto.\n'));
    console.log(chalk.gray('Example: --functions resolveImport,resolveReExport'));
    process.exit(1);
  }

  // Prepare split options
  const splitOptions: SplitOptions = {
    source,
    target: options.extract || generateTargetPath(source),
    functions: functionsList,
    auto: options.auto,
    dryRun: options.dryRun,
    skipConfirmation: options.yes,
  };

  const spinner = ora('Analyzing file structure...').start();

  try {
    // First, get a preview
    const preview = await previewSplit(splitOptions);

    spinner.stop();

    if (!preview.success) {
      console.log(chalk.red('\nSplit failed:'));
      for (const error of preview.errors || []) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }

    // JSON output
    if (options.json) {
      const jsonResult = {
        success: preview.success,
        sourceFile: preview.sourceFile,
        targetFile: preview.targetFile,
        extractedFunctions: preview.extractedFunctions,
        addedImports: preview.addedImports,
        reExports: preview.reExports,
        updatedFiles: preview.updatedFiles,
        preview: preview.preview
          ? {
              sourceContent: preview.preview.sourceContent,
              targetContent: preview.preview.targetContent,
              externalUpdates: Object.fromEntries(preview.preview.externalUpdates),
            }
          : undefined,
      };
      console.log(JSON.stringify(jsonResult, null, 2));
      return;
    }

    // Display preview
    displaySplitPreview(preview);

    // If dry-run, stop here
    if (options.dryRun) {
      console.log(chalk.gray('\nDry run - no changes made.\n'));
      return;
    }

    // Confirm with user (skip if --yes flag is set)
    if (!options.yes) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: 'Apply these changes?',
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('\nCancelled. No changes made.\n'));
        return;
      }
    }

    // Execute the split
    spinner.start('Extracting functions...');

    const result = await splitFile(splitOptions);

    if (result.success) {
      spinner.succeed('Split completed successfully');
      displaySplitResult(result);
    } else {
      spinner.fail('Split failed');
      console.log(chalk.red('\nErrors:'));
      for (const error of result.errors || []) {
        console.log(chalk.red(`  - ${error}`));
      }
      process.exit(1);
    }
  } catch (error) {
    spinner.fail('Split failed');
    console.error(chalk.red(`\nError: ${error}\n`));
    process.exit(1);
  }
}

function generateTargetPath(source: string): string {
  const ext = path.extname(source);
  const base = path.basename(source, ext);
  const dir = path.dirname(source);
  return path.join(dir, `${base}.helpers${ext}`);
}

function displaySplitPreview(result: SplitResult): void {
  console.log(chalk.cyan('\n=== Split Preview ===\n'));

  console.log(chalk.white('Source file: ') + chalk.yellow(result.sourceFile));
  console.log(chalk.white('Target file: ') + chalk.green(result.targetFile));
  console.log('');

  console.log(chalk.cyan('Functions to extract:'));
  for (const func of result.extractedFunctions) {
    console.log(chalk.green(`  + ${func}`));
  }
  console.log('');

  if (result.addedImports.length > 0) {
    console.log(chalk.cyan('Imports to add to source:'));
    for (const imp of result.addedImports) {
      console.log(chalk.blue(`  ${imp}`));
    }
    console.log('');
  }

  if (result.reExports.length > 0) {
    console.log(chalk.cyan('Re-exports to add to source (for backward compatibility):'));
    for (const exp of result.reExports) {
      console.log(chalk.magenta(`  ${exp}`));
    }
    console.log('');
  }

  if (result.updatedFiles.length > 0) {
    console.log(chalk.cyan('External files to update:'));
    for (const file of result.updatedFiles) {
      console.log(chalk.yellow(`  ~ ${file}`));
    }
    console.log('');
  }

  // Show content preview
  if (result.preview) {
    console.log(chalk.gray('---'));
    console.log(chalk.cyan('\nNew file preview (') + chalk.green(result.targetFile) + chalk.cyan('):'));
    console.log(chalk.gray('---'));
    const targetLines = result.preview.targetContent.split('\n');
    const previewLines = targetLines.slice(0, 30);
    for (const line of previewLines) {
      console.log(chalk.gray('  ') + line);
    }
    if (targetLines.length > 30) {
      console.log(chalk.gray(`  ... and ${targetLines.length - 30} more lines`));
    }
    console.log(chalk.gray('---'));
  }
}

function displaySplitResult(result: SplitResult): void {
  console.log(chalk.cyan('\n=== Split Complete ===\n'));

  console.log(chalk.white('Created: ') + chalk.green(result.targetFile));
  console.log(
    chalk.white('Extracted: ') +
      chalk.yellow(`${result.extractedFunctions.length} function(s)`)
  );

  if (result.extractedFunctions.length > 0) {
    console.log('');
    for (const func of result.extractedFunctions) {
      console.log(chalk.green(`  + ${func}`));
    }
  }

  if (result.updatedFiles.length > 0) {
    console.log('');
    console.log(chalk.white('Updated imports in: '));
    for (const file of result.updatedFiles) {
      console.log(chalk.yellow(`  ~ ${file}`));
    }
  }

  console.log('');
  console.log(chalk.gray('Tip: Run `consuela verify` to ensure the refactor is safe.\n'));
}
