#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import {
  configCommand,
  initCommand,
  exportsCommand,
  traceCommand,
  unusedCommand,
  impactCommand,
  diffCommand,
  tidyCommand,
  circularCommand,
  mapCommand,
  scanCommand,
  verifyCommand,
  extractCommand,
  diagnoseCommand,
  cleanupCommand,
  splitCommand,
  mergeCommand,
  fixCommand,
  reorganizeCommand,
  quickfixCommand,
} from './commands/index.js';

const program = new Command();

program
  .name('consuela')
  .description(
    chalk.green('🧹 Consuela') +
      ' - Code Analysis & Cleanup Tool\n' +
      chalk.gray('Find issues, fix them automatically, restructure your codebase')
  )
  .version('1.0.0');

// =============================================================================
// CORE COMMANDS (the "wow" experience)
// =============================================================================

// Default action - quick health check
program
  .action(async () => {
    await initCommand();
  });

program
  .command('fix')
  .description('✨ Fix it for me! Remove dead code, clean up files, restructure')
  .option('--dry-run', 'Preview what would be fixed (no changes)')
  .option('--deep', 'Also: AI splits large files (needs API key)')
  .option('--all', 'Also: AI restructures codebase (needs API key)')
  .option('--fail', 'Exit with code 1 if issues found (for CI)')
  .option('--json', 'Output as JSON')
  .action(async (options: { dryRun?: boolean; deep?: boolean; all?: boolean; fail?: boolean; json?: boolean }) => {
    await quickfixCommand(options);
  });

program
  .command('diagnose')
  .description('🏥 Get a health report with specific issues to fix')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    await diagnoseCommand(options);
  });

program
  .command('trace <symbol>')
  .description('🔍 Find everywhere a function/class/type is used')
  .option('--json', 'Output as JSON')
  .action(async (symbol, options) => {
    await traceCommand(symbol, options);
  });

program
  .command('impact <file>')
  .description('💥 See what breaks if you change a file')
  .option('--json', 'Output as JSON')
  .action(async (file, options) => {
    await impactCommand(file, options);
  });

program
  .command('reorganize [directory]')
  .description('🏗️  AI suggests a better folder structure (free Gemini API)')
  .option('--dry-run', 'Preview proposed changes')
  .option('--interactive', 'Approve each move individually')
  .option('--aggressive', 'More dramatic restructuring')
  .option('-y, --yes', 'Skip confirmation prompts')
  .option('--json', 'Output as JSON')
  .option('--exclude <patterns...>', 'Glob patterns to exclude')
  .option('--undo', 'Restore from backup')
  .option('--list-backups', 'List available backups')
  .option('--no-backup', 'Skip backup')
  .action(async (directory, options) => {
    await reorganizeCommand(directory, options);
  });

program
  .command('config')
  .description('⚙️  Set up free Gemini API key for AI features')
  .action(async () => {
    await configCommand();
  });

// =============================================================================
// ADVANCED COMMANDS (hidden from main help, accessible via --help-all)
// =============================================================================

const advanced = program.command('advanced').description('Advanced commands for power users');
(advanced as unknown as { _hidden: boolean })._hidden = true;

advanced
  .command('unused')
  .description('Find exports that are never used')
  .option('--json', 'Output as JSON')
  .option('--strict', 'Include entry points')
  .option('--fail', 'Exit with code 1 if unused found (for CI)')
  .action(async (options: { json?: boolean; strict?: boolean; fail?: boolean }) => {
    await unusedCommand(options);
  });

advanced
  .command('circular')
  .description('Find circular dependencies')
  .option('--json', 'Output as JSON')
  .option('--fail', 'Exit with code 1 if circular deps found')
  .action(async (options: { json?: boolean; fail?: boolean }) => {
    await circularCommand(options);
  });

advanced
  .command('exports')
  .description('List all exports')
  .option('--json', 'Output as JSON')
  .option('-f, --file <path>', 'Filter by file')
  .option('-k, --kind <kind>', 'Filter by kind')
  .action(async (options: { json?: boolean; file?: string; kind?: string }) => {
    await exportsCommand(options);
  });

advanced
  .command('diff [branch]')
  .description('Compare exports against a git branch')
  .option('--json', 'Output as JSON')
  .option('--fail', 'Exit with code 1 if breaking changes')
  .action(async (branch: string | undefined, options: { json?: boolean; fail?: boolean }) => {
    await diffCommand(branch, options);
  });

advanced
  .command('tidy <file>')
  .description('AI cleanup of a single file')
  .option('--apply', 'Apply changes')
  .option('--dry-run', 'Preview changes')
  .option('--skip-verify', 'Skip verification')
  .action(async (file: string, options: { apply?: boolean; dryRun?: boolean; skipVerify?: boolean }) => {
    await tidyCommand(file, options);
  });

advanced
  .command('map')
  .description('Generate codebase map for AI')
  .option('--json', 'Output as JSON')
  .option('-f, --file <path>', 'Focus on file')
  .option('-d, --depth <n>', 'Dependency depth', '2')
  .action(async (options: { json?: boolean; file?: string; depth?: string }) => {
    await mapCommand(options);
  });

advanced
  .command('scan')
  .description('Build function-level graph')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await scanCommand(options);
  });

advanced
  .command('verify')
  .description('Verify structure matches Gold Standard')
  .option('--json', 'Output as JSON')
  .option('--fail', 'Exit with code 1 if changes found')
  .action(async (options: { json?: boolean; fail?: boolean }) => {
    await verifyCommand(options);
  });

advanced
  .command('extract')
  .description('Find pure functions')
  .option('--pure', 'Show only pure')
  .option('--impure', 'Show only impure')
  .option('--json', 'Output as JSON')
  .option('-f, --file <path>', 'Filter by file')
  .action(async (options: { pure?: boolean; impure?: boolean; json?: boolean; file?: string }) => {
    await extractCommand(options);
  });

advanced
  .command('cleanup')
  .description('Manual dead code removal')
  .option('--unused', 'Remove unused')
  .option('--duplicates', 'Consolidate duplicates')
  .option('--all', 'Everything')
  .option('--dry-run', 'Preview')
  .option('-y, --yes', 'Skip prompt')
  .option('--json', 'Output as JSON')
  .action(async (options: { unused?: boolean; duplicates?: boolean; all?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
    await cleanupCommand(options);
  });

advanced
  .command('split <source>')
  .description('Extract functions to new file')
  .option('-e, --extract <file>', 'Target file')
  .option('-f, --functions <list>', 'Function names')
  .option('--auto', 'AI decides')
  .option('--dry-run', 'Preview')
  .option('-y, --yes', 'Skip prompt')
  .option('--json', 'Output as JSON')
  .action(async (source: string, options: { extract?: string; functions?: string; auto?: boolean; dryRun?: boolean; yes?: boolean; json?: boolean }) => {
    await splitCommand(source, options);
  });

advanced
  .command('merge <files...>')
  .description('Merge files into one')
  .option('--into <file>', 'Target file')
  .option('--dry-run', 'Preview')
  .option('--json', 'Output as JSON')
  .option('--keep-originals', 'Keep original files')
  .action(async (files: string[], options: { into?: string; dryRun?: boolean; json?: boolean; keepOriginals?: boolean }) => {
    await mergeCommand(files, options as { into: string; dryRun?: boolean; json?: boolean; keepOriginals?: boolean });
  });

advanced
  .command('ai-fix')
  .description('AI-powered autonomous fix')
  .option('--dry-run', 'Preview')
  .option('--verbose', 'Detailed output')
  .option('--aggressive', 'More aggressive')
  .option('--max-iterations <n>', 'Max cycles', '10')
  .option('--skip-verify', 'Skip verification')
  .option('--no-git', 'No git commits')
  .option('--no-verify', 'Skip build verification')
  .option('--json', 'Output as JSON')
  .action(async (options: { dryRun?: boolean; verbose?: boolean; aggressive?: boolean; maxIterations: string; skipVerify?: boolean; git?: boolean; verify?: boolean; json?: boolean }) => {
    await fixCommand({
      ...options,
      maxIterations: parseInt(options.maxIterations, 10),
    });
  });

// =============================================================================
// HELP TEXT
// =============================================================================

program.addHelpText(
  'after',
  `
${chalk.green.bold('Get Started:')}
  ${chalk.white('$')} consuela                 ${chalk.gray('# 1. See your codebase summary')}
  ${chalk.white('$')} consuela fix             ${chalk.gray('# 2. Auto-remove dead code')}
  ${chalk.white('$')} consuela fix --all       ${chalk.gray('# 3. Full cleanup (with AI)')}

${chalk.cyan('Explore Your Code:')}
  ${chalk.white('$')} consuela trace useState  ${chalk.gray('# Where is useState used?')}
  ${chalk.white('$')} consuela impact api.ts   ${chalk.gray('# What breaks if I change this?')}
  ${chalk.white('$')} consuela diagnose        ${chalk.gray('# Full health report')}

${chalk.yellow('AI Features')} ${chalk.gray('(free Gemini API key):')}
  ${chalk.white('$')} consuela config          ${chalk.gray('# Set up API key')}
  ${chalk.white('$')} consuela fix --deep      ${chalk.gray('# AI cleans up large files')}
  ${chalk.white('$')} consuela fix --all       ${chalk.gray('# AI restructures codebase')}

${chalk.gray('Power users: consuela advanced --help')}
`
);

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red(`\nUnknown command: ${program.args.join(' ')}`));
  console.log(chalk.gray(`Run ${chalk.white('consuela --help')} for usage.\n`));
  process.exit(1);
});

program.parse();
