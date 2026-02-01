/**
 * quickfix command - Automatically fix issues in the codebase
 *
 * This is the "Fixed it for you" command. It:
 * 1. Shows health score before
 * 2. Finds and fixes dead code
 * 3. Optionally runs AI-powered deep fixes (--deep)
 * 4. Verifies the build still passes
 * 5. Shows health score after with improvement
 *
 * Usage:
 *   consuela fix              # Fix dead code automatically
 *   consuela fix --deep       # AI-powered deep cleanup (large files, etc.)
 *   consuela fix --dry-run    # Preview what would be fixed
 */

import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createConfiguredAnalyzer, type ProjectAnalysis, type ProjectAnalyzer } from '../core/index.js';
import { createGraphAnalyzer, type FunctionGraph } from '../graph/index.js';
import { hasGlobalApiKey, configCommand, getGlobalApiKey } from './config.js';
import { cleanup, type CleanupOptions } from '../refactor/operations/cleanup.js';
import { createGeminiClient, type TidyContext } from '../core/gemini.js';
import { reorganize } from '../refactor/operations/reorganize.js';

interface QuickfixOptions {
  dryRun?: boolean;
  deep?: boolean;
  all?: boolean;
  fail?: boolean;
  json?: boolean;
}

interface FixedItem {
  type: 'removed-export' | 'removed-file' | 'split-file' | 'tidied-file' | 'reorganized';
  file: string;
  name?: string;
  kind?: string;
  line?: number;
  details?: string;
}

interface HealthScore {
  score: number;
  issues: {
    deadCode: number;
    largeFiles: number;
    circularDeps: number;
  };
}

// Calculate a simple health score
function calculateHealth(
  analyzer: ProjectAnalyzer,
  analysis: ProjectAnalysis,
  graph: FunctionGraph
): HealthScore {
  let score = 100;

  // Dead code penalty
  const unused = analyzer.findUnusedExports(analysis);
  const deadCode = unused.filter(u => !u.reason.includes('Entry point')).length;
  score -= Math.min(20, deadCode * 2);

  // Large files penalty
  let largeFiles = 0;
  for (const file of graph.files) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
      const lines = content.split('\n').length;
      if (lines > 300) {
        largeFiles++;
        score -= 5;
      }
    } catch {
      // ignore
    }
  }

  // Circular deps penalty
  const circularDeps = analysis.circularDependencies.length;
  score -= circularDeps * 3;

  return {
    score: Math.max(0, Math.round(score)),
    issues: { deadCode, largeFiles, circularDeps },
  };
}

function formatScore(score: number): string {
  if (score >= 80) return chalk.green.bold(`${score}/100`);
  if (score >= 50) return chalk.yellow.bold(`${score}/100`);
  return chalk.red.bold(`${score}/100`);
}

export async function quickfixCommand(options: QuickfixOptions = {}): Promise<void> {
  const rootDir = process.cwd();
  const fixed: FixedItem[] = [];
  const errors: string[] = [];

  if (!options.json) {
    console.log(chalk.cyan.bold('\n🔧 Consuela Fix\n'));
  }

  // --all implies --deep
  if (options.all) {
    options.deep = true;
  }

  // Check for API key if deep or all mode
  if ((options.deep || options.all) && !hasGlobalApiKey()) {
    if (!options.json) {
      console.log(chalk.yellow('  AI-powered fixes require an API key.\n'));

      const { setupKey } = await inquirer.prompt([{
        type: 'confirm',
        name: 'setupKey',
        message: 'Would you like to configure your API key now?',
        default: true,
      }]);

      if (setupKey) {
        await configCommand();
        console.log('');
        // Re-check after config
        if (!hasGlobalApiKey()) {
          console.log(chalk.gray('  Running basic mode only.\n'));
          options.deep = false;
          options.all = false;
        }
      } else {
        console.log(chalk.gray('  Running basic mode only.\n'));
        options.deep = false;
        options.all = false;
      }
    } else {
      console.log(JSON.stringify({
        success: false,
        error: 'AI features require API key. Run: consuela config',
      }, null, 2));
      return;
    }
  }

  const spinner = options.json ? null : ora('Analyzing codebase...').start();

  try {
    // Step 1: Analyze and get initial health score
    const analyzer = createConfiguredAnalyzer();
    const graphAnalyzer = createGraphAnalyzer();

    const [analysis, graph] = await Promise.all([
      analyzer.analyze(),
      graphAnalyzer.buildGraph(),
    ]);

    const healthBefore = calculateHealth(analyzer, analysis, graph);

    if (spinner) spinner.succeed('Analysis complete');

    if (!options.json) {
      console.log(`\n  Health Score: ${formatScore(healthBefore.score)}`);
      console.log(chalk.gray(`    Dead code: ${healthBefore.issues.deadCode} | Large files: ${healthBefore.issues.largeFiles} | Circular: ${healthBefore.issues.circularDeps}`));
      console.log('');
    }

    // Step 2: Find issues to fix
    const unused = analyzer.findUnusedExports(analysis);
    const trulyUnused = unused.filter(u => !u.reason.includes('Entry point'));

    // Find large files for deep mode
    const largeFiles: { file: string; lines: number }[] = [];
    if (options.deep) {
      for (const file of graph.files) {
        try {
          const content = fs.readFileSync(path.join(rootDir, file), 'utf-8');
          const lines = content.split('\n').length;
          if (lines > 300) {
            largeFiles.push({ file, lines });
          }
        } catch {
          // ignore
        }
      }
      largeFiles.sort((a, b) => b.lines - a.lines);
    }

    const hasDeadCode = trulyUnused.length > 0;
    const hasLargeFiles = largeFiles.length > 0;
    const hasWork = hasDeadCode || (options.deep && hasLargeFiles);

    if (!hasWork) {
      if (options.json) {
        console.log(JSON.stringify({
          success: true,
          message: 'No issues to fix',
          healthBefore: healthBefore.score,
          healthAfter: healthBefore.score,
          fixed: [],
        }, null, 2));
      } else {
        console.log(chalk.green('  ✓ Your codebase is clean! Nothing to fix.\n'));
      }
      return;
    }

    // Step 3: Show what will be fixed
    if (!options.json) {
      console.log(chalk.white('  Issues to fix:'));

      if (hasDeadCode) {
        console.log(chalk.yellow(`    • ${trulyUnused.length} unused export(s)`));
      }
      if (options.deep && hasLargeFiles) {
        console.log(chalk.yellow(`    • ${largeFiles.length} large file(s) to clean up`));
        for (const { file, lines } of largeFiles.slice(0, 3)) {
          console.log(chalk.gray(`        ${file} (${lines} lines)`));
        }
        if (largeFiles.length > 3) {
          console.log(chalk.gray(`        ... and ${largeFiles.length - 3} more`));
        }
      }
      console.log('');
    }

    // Step 4: Dry run - just show what would be fixed
    if (options.dryRun) {
      if (options.json) {
        console.log(JSON.stringify({
          dryRun: true,
          healthBefore: healthBefore.score,
          wouldFix: {
            unusedExports: trulyUnused.map(u => ({
              file: u.export.filePath,
              name: u.export.name,
              kind: u.export.kind,
            })),
            largeFiles: options.deep ? largeFiles : [],
          },
        }, null, 2));
      } else {
        console.log(chalk.gray('  Dry run - no changes made.'));
        console.log(chalk.gray('  Run without --dry-run to fix automatically.\n'));
      }
      // Exit with code 1 if --fail and there are issues
      if (options.fail && hasWork) {
        process.exit(1);
      }
      return;
    }

    // Step 5: Fix dead code
    if (hasDeadCode) {
      const fixSpinner = options.json ? null : ora('Removing dead code...').start();

      const cleanupOptions: CleanupOptions = {
        removeUnused: true,
        removeDuplicates: false,
        removeEmptyFiles: true,
        dryRun: false,
        rootDir,
      };

      const result = await cleanup(cleanupOptions);

      if (!result.success) {
        if (fixSpinner) fixSpinner.fail('Dead code removal failed');
        errors.push(...result.errors);
      } else {
        for (const exp of result.removedExports) {
          fixed.push({
            type: 'removed-export',
            file: exp.file,
            name: exp.name,
            kind: exp.kind,
            line: exp.line,
          });
        }
        for (const file of result.removedFiles) {
          fixed.push({ type: 'removed-file', file });
        }
        if (fixSpinner) fixSpinner.succeed(`Removed ${result.removedExports.length} unused export(s)`);
      }
    }

    // Step 6: Deep mode - tidy large files with AI
    if (options.deep && hasLargeFiles) {
      const apiKey = getGlobalApiKey()!;
      const gemini = createGeminiClient(apiKey);
      const filesToTidy = largeFiles.slice(0, 3); // Limit to 3 files per run

      for (const { file, lines } of filesToTidy) {
        const tidySpinner = options.json ? null : ora(`Cleaning up ${file} (${lines} lines)...`).start();

        try {
          const absolutePath = path.join(rootDir, file);
          const fileContent = fs.readFileSync(absolutePath, 'utf-8');

          // Build context for AI
          const fileAnalysis = analysis.files.get(file);
          const context: TidyContext = {};

          if (fileAnalysis) {
            context.exports = fileAnalysis.exports.map(exp => {
              const trace = analysis.symbolTraces.get(`${file}:${exp.name}`);
              return { name: exp.name, kind: exp.kind, usageCount: trace?.usageCount || 0 };
            });
            context.imports = fileAnalysis.imports.map(imp => ({ name: imp.name, source: imp.source }));
            const dependents = analysis.reverseGraph.get(file);
            if (dependents) context.dependents = Array.from(dependents);
            context.unusedExports = trulyUnused
              .filter(u => u.export.filePath === file)
              .map(u => u.export.name);
          }

          if (tidySpinner) tidySpinner.text = `AI analyzing ${file}...`;

          const result = await gemini.tidyCode(file, fileContent, context);

          if (result.cleanedCode && result.cleanedCode !== fileContent) {
            fs.writeFileSync(absolutePath, result.cleanedCode);
            fixed.push({
              type: 'tidied-file',
              file,
              details: result.changes?.join(', ') || 'Cleaned up',
            });
            if (tidySpinner) tidySpinner.succeed(`Cleaned up ${file}`);
          } else {
            if (tidySpinner) tidySpinner.info(`${file}: No changes needed`);
          }
        } catch (err) {
          if (tidySpinner) tidySpinner.fail(`Error cleaning up ${file}`);
          errors.push(`Error tidying ${file}: ${err}`);
        }
      }

      if (largeFiles.length > 3) {
        if (!options.json) {
          console.log(chalk.gray(`  Note: ${largeFiles.length - 3} more files to clean. Run again to continue.`));
        }
      }
    }

    // Step 7: All mode - reorganize codebase
    if (options.all && (healthBefore.issues.circularDeps > 0 || healthBefore.issues.largeFiles > 5)) {
      const reorgSpinner = options.json ? null : ora('AI reorganizing codebase structure...').start();

      try {
        const result = await reorganize({
          rootDir,
          dryRun: false,
          yes: true, // Skip prompts in fix --all mode
        });

        if (result.success && result.movedFiles.length > 0) {
          fixed.push({
            type: 'reorganized',
            file: 'codebase',
            details: `Moved ${result.movedFiles.length} files, updated ${result.updatedImports.length} imports`,
          });
          if (reorgSpinner) reorgSpinner.succeed(`Reorganized: ${result.movedFiles.length} files moved`);
        } else if (result.movedFiles.length === 0) {
          if (reorgSpinner) reorgSpinner.info('No reorganization needed');
        } else {
          if (reorgSpinner) reorgSpinner.fail('Reorganization had issues');
          errors.push(...result.errors);
        }
      } catch (err) {
        if (reorgSpinner) reorgSpinner.fail('Reorganization failed');
        errors.push(`Reorganization error: ${err}`);
      }
    }

    // Step 8: Verify the build
    const verifySpinner = options.json ? null : ora('Verifying build...').start();

    let buildPassed = false;
    try {
      execSync('npx tsc --noEmit', { cwd: rootDir, stdio: 'pipe' });
      buildPassed = true;
      if (verifySpinner) verifySpinner.succeed('Build verified');
    } catch {
      buildPassed = false;
      if (verifySpinner) verifySpinner.fail('Build failed after fix');
      errors.push('TypeScript compilation failed after applying fixes');
    }

    // Step 9: Calculate new health score
    const analysisAfter = await analyzer.analyze();
    const graphAfter = await graphAnalyzer.buildGraph();
    const healthAfter = calculateHealth(analyzer, analysisAfter, graphAfter);

    const improvement = healthAfter.score - healthBefore.score;

    // Step 9: Output results
    if (options.json) {
      console.log(JSON.stringify({
        success: errors.length === 0,
        healthBefore: healthBefore.score,
        healthAfter: healthAfter.score,
        improvement,
        fixed,
        verified: buildPassed,
        errors,
      }, null, 2));
    } else {
      console.log('');

      // Summary
      if (fixed.length > 0) {
        console.log(chalk.green.bold('  ✓ Fixed:'));

        const removedExports = fixed.filter(f => f.type === 'removed-export');
        const removedFiles = fixed.filter(f => f.type === 'removed-file');
        const tidiedFiles = fixed.filter(f => f.type === 'tidied-file');
        const reorganized = fixed.filter(f => f.type === 'reorganized');

        if (removedExports.length > 0) {
          console.log(chalk.green(`    • Removed ${removedExports.length} unused export(s)`));
        }
        if (removedFiles.length > 0) {
          console.log(chalk.green(`    • Deleted ${removedFiles.length} empty file(s)`));
        }
        if (tidiedFiles.length > 0) {
          console.log(chalk.green(`    • Cleaned up ${tidiedFiles.length} large file(s)`));
        }
        if (reorganized.length > 0) {
          console.log(chalk.green(`    • Reorganized codebase structure`));
          for (const r of reorganized) {
            if (r.details) console.log(chalk.gray(`      ${r.details}`));
          }
        }
        console.log('');
      }

      // Health score change
      console.log(`  Health: ${formatScore(healthBefore.score)} → ${formatScore(healthAfter.score)}`);
      if (improvement > 0) {
        console.log(chalk.green(`          +${improvement} points 🎉`));
      } else if (improvement === 0 && fixed.length > 0) {
        console.log(chalk.gray(`          (score unchanged - try --deep for more)`));
      }
      console.log('');

      // Build status
      if (buildPassed) {
        console.log(chalk.green('  ✓ Build passes - changes are safe'));
      } else {
        console.log(chalk.red('  ✗ Build failed - review changes manually'));
      }

      // Errors
      if (errors.length > 0) {
        console.log(chalk.yellow('\n  Warnings:'));
        for (const error of errors.slice(0, 3)) {
          console.log(chalk.yellow(`    • ${error}`));
        }
        if (errors.length > 3) {
          console.log(chalk.gray(`    ... and ${errors.length - 3} more`));
        }
      }

      // Next steps
      console.log(chalk.gray('\n  Next steps:'));
      if (!options.deep && !options.all && healthAfter.issues.largeFiles > 0) {
        console.log(chalk.cyan('    • Run `consuela fix --deep` for AI-powered cleanup'));
      }
      if (!options.all && healthAfter.issues.circularDeps > 0) {
        console.log(chalk.cyan('    • Run `consuela fix --all` for full codebase restructure'));
      }
      if (!options.all && !options.deep && (healthAfter.issues.largeFiles > 0 || healthAfter.issues.circularDeps > 0)) {
        console.log(chalk.cyan('    • Or run `consuela fix --all` for the full treatment'));
      }
      console.log(chalk.gray('    • Run `git diff` to review changes'));
      console.log(chalk.gray('    • Commit with: git commit -am "chore: code cleanup"'));
      console.log('');
    }

  } catch (error) {
    if (spinner) spinner.fail('Fix failed');

    if (options.json) {
      console.log(JSON.stringify({
        success: false,
        error: String(error),
        fixed: [],
      }, null, 2));
    } else {
      console.error(chalk.red(`\nError: ${error}\n`));
    }
    process.exit(1);
  }
}
