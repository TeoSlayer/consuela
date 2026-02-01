import chalk from 'chalk';
import ora from 'ora';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAnalyzer, type BreakingChange, type ProjectAnalysis } from '../core/analyzer.js';

interface DiffOptions {
  json?: boolean;
  fail?: boolean; // Exit with code 1 if breaking changes found (for CI)
}

// Track temp directories for cleanup on unexpected exit
const tempDirs: string[] = [];

function cleanupTempDirs(): void {
  for (const dir of tempDirs) {
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Best effort cleanup
    }
  }
  tempDirs.length = 0;
}

// Register cleanup handlers
process.on('exit', cleanupTempDirs);
process.on('SIGINT', () => { cleanupTempDirs(); process.exit(130); });
process.on('SIGTERM', () => { cleanupTempDirs(); process.exit(143); });
process.on('uncaughtException', (err) => {
  cleanupTempDirs();
  console.error('Uncaught exception:', err);
  process.exit(1);
});

export async function diffCommand(branch: string = 'main', options: DiffOptions): Promise<void> {
  const spinner = ora('Analyzing current codebase...').start();
  let tempDir: string | null = null;

  try {
    // Check if we're in a git repo
    try {
      execSync('git rev-parse --git-dir', { stdio: 'ignore' });
    } catch {
      spinner.fail('Not a git repository');
      console.log(chalk.gray('\nRun this command inside a git repository.\n'));
      process.exit(1);
    }

    // Check if branch exists
    try {
      execSync(`git rev-parse --verify ${branch}`, { stdio: 'ignore' });
    } catch {
      spinner.fail(`Branch "${branch}" not found`);
      process.exit(1);
    }

    // Analyze current codebase (disable cache for diff to ensure fresh analysis)
    const currentAnalyzer = createAnalyzer(process.cwd(), undefined, { cache: false });
    const currentAnalysis = await currentAnalyzer.analyze();

    spinner.text = `Checking out ${branch} to compare...`;

    // Create temp directory and track it for cleanup
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-diff-'));
    tempDirs.push(tempDir);

    // Get the list of files from the branch
    const files = execSync(`git ls-tree -r --name-only ${branch}`, { encoding: 'utf-8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.mjs'));

    // Checkout each file to temp dir
    for (const file of files) {
      const targetPath = path.join(tempDir, file);
      const targetDir = path.dirname(targetPath);

      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      try {
        const content = execSync(`git show ${branch}:${file}`, { encoding: 'utf-8' });
        fs.writeFileSync(targetPath, content);
      } catch {
        // File might not exist in that branch
      }
    }

    // Copy tsconfig if it exists
    try {
      const tsconfig = execSync(`git show ${branch}:tsconfig.json`, { encoding: 'utf-8' });
      fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), tsconfig);
    } catch {
      // No tsconfig in that branch
    }

    // Copy package.json for entry point detection
    try {
      const pkg = execSync(`git show ${branch}:package.json`, { encoding: 'utf-8' });
      fs.writeFileSync(path.join(tempDir, 'package.json'), pkg);
    } catch {
      // No package.json in that branch
    }

    spinner.text = `Analyzing ${branch}...`;

    // Analyze the old version (disable cache)
    const oldAnalyzer = createAnalyzer(tempDir, undefined, { cache: false });
    const oldAnalysis = await oldAnalyzer.analyze();

    spinner.text = 'Comparing exports...';

    // Compare
    const breakingChanges = currentAnalyzer.compareExports(oldAnalysis, currentAnalysis);
    const newExports = findNewExports(oldAnalysis, currentAnalysis);

    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
    const idx = tempDirs.indexOf(tempDir);
    if (idx > -1) tempDirs.splice(idx, 1);
    tempDir = null;

    spinner.succeed('Comparison complete');

    if (options.json) {
      console.log(JSON.stringify({
        branch,
        breakingChanges,
        newExports,
        circularDependencies: currentAnalysis.circularDependencies,
      }, null, 2));
      if (options.fail && breakingChanges.length > 0) {
        process.exit(1);
      }
      return;
    }

    printDiff(branch, breakingChanges, newExports, currentAnalysis.circularDependencies);

    if (options.fail && breakingChanges.length > 0) {
      process.exit(1);
    }
  } catch (error) {
    // Clean up on error
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        const idx = tempDirs.indexOf(tempDir);
        if (idx > -1) tempDirs.splice(idx, 1);
      } catch {
        // Ignore cleanup errors
      }
    }
    spinner.fail('Diff failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function findNewExports(
  oldAnalysis: ProjectAnalysis,
  newAnalysis: ProjectAnalysis
): Array<{ name: string; filePath: string; kind: string }> {
  const newExports: Array<{ name: string; filePath: string; kind: string }> = [];

  for (const [key, trace] of newAnalysis.symbolTraces) {
    if (!oldAnalysis.symbolTraces.has(key)) {
      newExports.push({
        name: trace.symbol.name,
        filePath: trace.symbol.filePath,
        kind: trace.symbol.kind,
      });
    }
  }

  return newExports;
}

function printDiff(
  branch: string,
  breakingChanges: BreakingChange[],
  newExports: Array<{ name: string; filePath: string; kind: string }>,
  circularDependencies: string[][] = []
): void {
  console.log(chalk.cyan(`\n📊 API Diff: current vs ${branch}\n`));
  console.log(chalk.gray('─'.repeat(50)));

  // Circular dependencies warning
  if (circularDependencies.length > 0) {
    console.log(chalk.yellow(`\n  ⚠ Circular Dependencies (${circularDependencies.length}):\n`));
    for (const cycle of circularDependencies.slice(0, 5)) {
      console.log(`    ${chalk.yellow('↻')} ${cycle.join(' → ')} → ${cycle[0]}`);
    }
    if (circularDependencies.length > 5) {
      console.log(chalk.gray(`    ... and ${circularDependencies.length - 5} more`));
    }
    console.log('');
  }

  // Breaking changes
  if (breakingChanges.length === 0) {
    console.log(chalk.green('\n  ✓ No breaking changes detected\n'));
  } else {
    console.log(chalk.red(`\n  ⚠ Breaking Changes (${breakingChanges.length}):\n`));

    const removed = breakingChanges.filter((c) => c.type === 'removed');
    const signatureChanged = breakingChanges.filter((c) => c.type === 'signature_changed');

    if (removed.length > 0) {
      console.log(chalk.red('    Removed exports:'));
      for (const change of removed) {
        console.log(`      ${chalk.red('✗')} ${change.export.name} ${chalk.gray(`(${change.export.filePath})`)}`);
        if (change.affectedFiles.length > 0) {
          console.log(chalk.yellow(`        → Breaks ${change.affectedFiles.length} files`));
        }
      }
      console.log('');
    }

    if (signatureChanged.length > 0) {
      console.log(chalk.yellow('    Changed signatures:'));
      for (const change of signatureChanged) {
        console.log(`      ${chalk.yellow('~')} ${change.export.name} ${chalk.gray(`(${change.export.filePath})`)}`);
        console.log(chalk.gray(`        ${change.details.split('\n').join('\n        ')}`));
        if (change.affectedFiles.length > 0) {
          console.log(chalk.yellow(`        → Affects ${change.affectedFiles.length} files`));
        }
      }
      console.log('');
    }
  }

  // New exports
  if (newExports.length > 0) {
    console.log(chalk.green(`  ✓ New Exports (${newExports.length}):\n`));

    // Group by file
    const byFile = new Map<string, typeof newExports>();
    for (const exp of newExports) {
      const existing = byFile.get(exp.filePath) || [];
      existing.push(exp);
      byFile.set(exp.filePath, existing);
    }

    for (const [file, exports] of byFile) {
      console.log(`    ${chalk.white(file)}`);
      for (const exp of exports) {
        console.log(`      ${chalk.green('+')} ${exp.name} ${chalk.gray(`[${exp.kind}]`)}`);
      }
    }
    console.log('');
  }

  // Summary
  console.log(chalk.gray('─'.repeat(50)));
  console.log(chalk.white('\n  Summary:'));
  console.log(`    Breaking changes: ${breakingChanges.length > 0 ? chalk.red(breakingChanges.length) : chalk.green('0')}`);
  console.log(`    New exports:      ${chalk.green(newExports.length)}`);
  if (circularDependencies.length > 0) {
    console.log(`    Circular deps:    ${chalk.yellow(circularDependencies.length)}`);
  }

  if (breakingChanges.length > 0) {
    const totalAffected = new Set(breakingChanges.flatMap((c) => c.affectedFiles)).size;
    console.log(`    Files affected:   ${chalk.yellow(totalAffected)}`);
  }

  // Verdict
  console.log('');
  if (breakingChanges.length === 0 && circularDependencies.length === 0) {
    console.log(chalk.green('  ✓ Safe to merge - no breaking changes\n'));
  } else if (breakingChanges.length === 0) {
    console.log(chalk.yellow('  ⚠ No breaking changes, but circular dependencies detected\n'));
  } else {
    console.log(chalk.red('  ✗ Review required - breaking changes detected\n'));
    console.log(chalk.gray('  Tip: Use `consuela trace <export>` to see what depends on changed exports\n'));
  }
}
