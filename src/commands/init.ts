import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConfiguredAnalyzer, type ProjectAnalysis, type SymbolTrace, type ProjectAnalyzer } from '../core/index.js';
import { hasGlobalApiKey } from './config.js';

export async function initCommand(): Promise<void> {
  console.log(chalk.green.bold('\n🧹 Consuela - Code Analysis Tool\n'));

  const spinner = ora('Analyzing codebase...').start();
  const startTime = Date.now();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    spinner.succeed(`Analysis completed in ${elapsed}s`);

    printSummary(analysis);

    // Show circular dependencies
    if (analysis.circularDependencies.length > 0) {
      console.log(chalk.yellow(`\n  ⚠ Found ${analysis.circularDependencies.length} circular dependencies`));
      for (const cycle of analysis.circularDependencies.slice(0, 3)) {
        console.log(chalk.gray(`    ↻ ${cycle.slice(0, 3).join(' → ')}${cycle.length > 3 ? ' → ...' : ''}`));
      }
      if (analysis.circularDependencies.length > 3) {
        console.log(chalk.gray(`    ... and ${analysis.circularDependencies.length - 3} more`));
      }
    }

    // Find unused exports
    const unused = analyzer.findUnusedExports(analysis);
    const trulyUnused = unused.filter((u) => !u.reason.includes('Entry point'));

    if (trulyUnused.length > 0) {
      console.log(chalk.yellow(`\n  ⚠ Found ${trulyUnused.length} potentially unused exports`));
      console.log(chalk.gray(`    Run \`consuela fix\` to remove them automatically`));
    }

    // Interactive menu (only if running in a TTY)
    if (process.stdout.isTTY) {
      console.log('');
      await promptNextAction(analysis, analyzer);
    } else {
      // Non-interactive mode - just print summary and exit
      console.log(chalk.gray('\n  Run `consuela --help` to see available commands.\n'));
    }
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printSummary(analysis: ProjectAnalysis): void {
  const fileCount = analysis.files.size;
  let exportCount = 0;
  let functionCount = 0;
  let classCount = 0;
  let typeCount = 0;

  for (const [, trace] of analysis.symbolTraces) {
    exportCount++;
    switch (trace.symbol.kind) {
      case 'function':
        functionCount++;
        break;
      case 'class':
        classCount++;
        break;
      case 'type':
      case 'interface':
        typeCount++;
        break;
    }
  }

  console.log(chalk.cyan('\n📊 Project Summary\n'));
  console.log(chalk.gray('─'.repeat(40)));
  console.log(`  Files analyzed:    ${chalk.white(fileCount)}`);
  console.log(`  Total exports:     ${chalk.white(exportCount)}`);
  console.log(`    Functions:       ${chalk.blue(functionCount)}`);
  console.log(`    Classes:         ${chalk.magenta(classCount)}`);
  console.log(`    Types:           ${chalk.cyan(typeCount)}`);
  console.log(chalk.gray('─'.repeat(40)));

  // Most connected files
  const filesByDependents = Array.from(analysis.reverseGraph.entries())
    .map(([file, dependents]) => ({ file, count: dependents.size }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  if (filesByDependents.length > 0 && filesByDependents[0].count > 0) {
    console.log(chalk.cyan('\n📌 Most Depended-On Files:\n'));
    for (const { file, count } of filesByDependents) {
      if (count > 0) {
        console.log(`    ${chalk.white(file)} ${chalk.gray(`(${count} dependents)`)}`);
      }
    }
  }

  // Most used exports
  const topExports = Array.from(analysis.symbolTraces.values())
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 5);

  if (topExports.length > 0 && topExports[0].usageCount > 0) {
    console.log(chalk.cyan('\n🔥 Most Used Exports:\n'));
    for (const trace of topExports) {
      if (trace.usageCount > 0) {
        console.log(`    ${chalk.green(trace.symbol.name)} ${chalk.gray(`(${trace.usageCount} usages)`)} - ${trace.symbol.filePath}`);
      }
    }
  }
}

async function promptNextAction(
  analysis: ProjectAnalysis,
  analyzer: ProjectAnalyzer
): Promise<void> {
  const hasApiKey = hasGlobalApiKey();

  const choices = [
    { name: '📦 View all exports', value: 'exports' },
    { name: '🔍 Trace a symbol (see where it\'s used)', value: 'trace' },
    { name: '🗑️  Find unused exports', value: 'unused' },
    { name: '💥 Check impact of a file', value: 'impact' },
    ...(hasApiKey ? [{ name: '🧹 Tidy a file with AI', value: 'tidy' }] : []),
    { name: '✅ Done', value: 'exit' },
  ];

  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices,
    },
  ]);

  switch (action) {
    case 'exports':
      console.log(chalk.gray('\n  Run: consuela exports\n'));
      break;

    case 'trace':
      await promptTrace(analysis);
      break;

    case 'unused':
      console.log(chalk.gray('\n  Run: consuela fix --dry-run   (to preview what would be removed)'));
      console.log(chalk.gray('  Run: consuela fix             (to remove unused exports)\n'));
      break;

    case 'impact':
      await promptImpact(analysis);
      break;

    case 'tidy':
      console.log(chalk.gray('\n  Run: consuela fix --deep      (AI-powered cleanup, requires API key)\n'));
      break;

    case 'exit':
      printHelp();
      break;
  }
}

async function promptTrace(analysis: ProjectAnalysis): Promise<void> {
  const exportNames = Array.from(analysis.symbolTraces.values())
    .map((t) => ({
      name: `${t.symbol.name} (${t.symbol.filePath})`,
      value: `${t.symbol.filePath}:${t.symbol.name}`,
    }))
    .slice(0, 20);

  if (exportNames.length === 0) {
    console.log(chalk.gray('\n  No exports found.\n'));
    return;
  }

  const { symbol } = await inquirer.prompt([
    {
      type: 'list',
      name: 'symbol',
      message: 'Select an export to trace:',
      choices: [...exportNames, { name: '← Back', value: 'back' }],
    },
  ]);

  if (symbol !== 'back') {
    console.log(chalk.gray(`\n  Run: consuela trace "${symbol}"\n`));
  }
}

async function promptImpact(analysis: ProjectAnalysis): Promise<void> {
  const files = Array.from(analysis.files.keys())
    .filter((f) => (analysis.files.get(f)?.exports.length || 0) > 0)
    .slice(0, 20);

  if (files.length === 0) {
    console.log(chalk.gray('\n  No files with exports found.\n'));
    return;
  }

  const { file } = await inquirer.prompt([
    {
      type: 'list',
      name: 'file',
      message: 'Select a file to check impact:',
      choices: [...files.map((f) => ({ name: f, value: f })), { name: '← Back', value: 'back' }],
    },
  ]);

  if (file !== 'back') {
    console.log(chalk.gray(`\n  Run: consuela impact ${file}\n`));
  }
}

function printHelp(): void {
  console.log(chalk.cyan('\n📚 Available Commands:\n'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`  ${chalk.white('consuela fix')}             Auto-fix issues (dead code, etc.)`);
  console.log(`  ${chalk.white('consuela fix --deep')}      AI-powered deep cleanup`);
  console.log(`  ${chalk.white('consuela diagnose')}        Full health report`);
  console.log(`  ${chalk.white('consuela trace <name>')}    See where a symbol is used`);
  console.log(`  ${chalk.white('consuela impact <file>')}   See what depends on a file`);
  console.log(`  ${chalk.white('consuela reorganize')}      AI-powered restructure`);
  console.log(chalk.gray('─'.repeat(50)));
  console.log('');
}
