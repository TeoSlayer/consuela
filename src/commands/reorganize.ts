/**
 * reorganize command - Transform a messy codebase into a well-organized project
 *
 * Uses AI to suggest domain-based organization with semantic file naming
 * and automatically updates all imports across the codebase.
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';
import inquirer from 'inquirer';
import {
  reorganize,
  previewReorganization,
  restoreFromBackup,
  listBackups,
  type ProgressCallback,
} from '../refactor/operations/reorganize.js';
import type { ReorganizeOptions } from '../refactor/types.js';
import { hasGlobalApiKey } from './config.js';
import type { ReorganizePlan, ReorganizeConflict } from '../refactor/types.js';

interface ReorganizeCommandOptions {
  dryRun?: boolean;
  interactive?: boolean;
  aggressive?: boolean;
  yes?: boolean;
  json?: boolean;
  exclude?: string[];
  undo?: boolean;
  listBackups?: boolean;
  noBackup?: boolean;
}

export async function reorganizeCommand(
  targetDir?: string,
  options: ReorganizeCommandOptions = {}
): Promise<void> {
  const rootDir = process.cwd();

  // Handle --undo flag
  if (options.undo) {
    console.log(chalk.cyan('\nRestoring from backup...\n'));
    const success = restoreFromBackup(rootDir);
    if (success) {
      console.log(chalk.green('Successfully restored from backup.'));
    } else {
      console.log(chalk.red('No backup found or restore failed.'));
      console.log(chalk.gray('Use --list-backups to see available backups.'));
    }
    return;
  }

  // Handle --list-backups flag
  if (options.listBackups) {
    const backups = listBackups(rootDir);
    if (backups.length === 0) {
      console.log(chalk.gray('\nNo backups found.\n'));
    } else {
      console.log(chalk.cyan('\nAvailable backups:\n'));
      for (const backup of backups) {
        console.log(chalk.white(`  ${backup.id}`));
        console.log(chalk.gray(`    Date: ${backup.date.toLocaleString()}`));
        console.log(chalk.gray(`    Files: ${backup.fileCount}`));
      }
      console.log('');
    }
    return;
  }

  // Check for Gemini API key
  if (!hasGlobalApiKey()) {
    console.log(chalk.red('\nError: Gemini API key is required for reorganization.\n'));
    console.log(chalk.gray('Run `consuela config` to set up your API key.'));
    process.exit(1);
  }

  const reorganizeOptions: ReorganizeOptions = {
    targetDir,
    dryRun: options.dryRun,
    interactive: options.interactive,
    aggressive: options.aggressive,
    yes: options.yes,
    json: options.json,
    rootDir,
    exclude: options.exclude || [],
    backup: !options.noBackup,
  };

  // Progress tracking - use object wrapper for TypeScript flow analysis
  const progress = { spinner: null as Ora | null, phase: '' };

  const phaseLabels: Record<string, string> = {
    analysis: 'Analyzing codebase',
    ai: 'Getting AI suggestion',
    planning: 'Generating plan',
    validation: 'Running safety checks',
    backup: 'Creating backup',
    execution: 'Applying changes',
    done: 'Done',
  };

  const onProgress: ProgressCallback = (phase, message, current, total) => {
    if (options.json) return;

    // Phase change - complete old spinner, start new one
    if (phase !== progress.phase) {
      if (progress.spinner) {
        progress.spinner.succeed();
      }
      progress.phase = phase;

      const label = phaseLabels[phase] || message;
      if (phase !== 'done') {
        progress.spinner = ora(label).start();
      }
    } else if (progress.spinner) {
      // Same phase - update spinner text
      if (current !== undefined && total !== undefined) {
        progress.spinner.text = `${message} (${current}/${total})`;
      } else {
        progress.spinner.text = message;
      }
    }
  };

  // Don't create initial spinner - let onProgress handle it

  try {
    // Get preview first
    const preview = await previewReorganization(reorganizeOptions, onProgress);
    progress.spinner?.stop();

    // Handle empty result
    if (preview.plan.operations.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({
          success: false,
          message: 'No reorganization suggestions available',
          plan: preview.plan,
        }, null, 2));
      } else {
        console.log(chalk.yellow('\nNo reorganization suggestions available.'));
        console.log(chalk.gray('This could mean:'));
        console.log(chalk.gray('  - The codebase is already well-organized'));
        console.log(chalk.gray('  - The target directory has no files'));
        console.log(chalk.gray('  - The AI could not determine a better structure\n'));
      }
      return;
    }

    // JSON output
    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        plan: preview.plan,
        currentTree: preview.currentTree,
        proposedTree: preview.proposedTree,
        safetyWarnings: preview.safetyWarnings,
        tsconfigUpdates: preview.tsconfigUpdates,
      }, null, 2));

      if (options.dryRun) {
        return;
      }
    } else {
      // Display preview
      displayReorganizationPreview(
        preview.plan,
        preview.currentTree,
        preview.proposedTree,
        preview.safetyWarnings,
        preview.tsconfigUpdates
      );
    }

    // If dry-run, stop here
    if (options.dryRun) {
      console.log(chalk.gray('\nDry run - no changes made.\n'));
      return;
    }

    // Check for conflicts
    if (preview.plan.conflicts.length > 0) {
      displayConflicts(preview.plan.conflicts);

      if (!options.yes) {
        const { proceed } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'proceed',
            message: chalk.yellow('There are conflicts. Continue anyway?'),
            default: false,
          },
        ]);

        if (!proceed) {
          console.log(chalk.gray('\nCancelled. Resolve conflicts before reorganizing.\n'));
          return;
        }
      }
    }

    // Interactive mode - approve each move
    if (options.interactive && !options.yes) {
      const approvedMoves = await interactiveApproval(preview.plan);
      if (approvedMoves.length === 0) {
        console.log(chalk.gray('\nNo changes approved. Cancelled.\n'));
        return;
      }

      // Filter the plan to only include approved moves
      preview.plan.operations = preview.plan.operations.filter(op => {
        if (op.type === 'move-file') {
          return approvedMoves.includes(op.from);
        }
        // Keep folder creates that are still needed for approved moves
        if (op.type === 'create-folder') {
          return preview.plan.operations.some(
            o => o.type === 'move-file' &&
                 approvedMoves.includes((o as { from: string }).from) &&
                 (o as { to: string }).to.startsWith(op.path + '/')
          );
        }
        // Keep barrel files for folders that have approved moves
        if (op.type === 'create-barrel') {
          const barrelDir = op.path.replace(/\/index\.ts$/, '');
          return preview.plan.operations.some(
            o => o.type === 'move-file' &&
                 approvedMoves.includes((o as { from: string }).from) &&
                 (o as { to: string }).to.startsWith(barrelDir + '/')
          );
        }
        return true;
      });

      // Update summary
      preview.plan.summary.filesToMove = approvedMoves.length;
    }

    // Confirm execution
    if (!options.yes && !options.json) {
      const { confirm } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Apply ${chalk.cyan(preview.plan.summary.filesToMove)} file moves and update ${chalk.cyan(preview.plan.summary.importsToRewrite)} imports?`,
          default: true,
        },
      ]);

      if (!confirm) {
        console.log(chalk.gray('\nCancelled. No changes made.\n'));
        return;
      }
    }

    // Execute reorganization
    const execSpinner = ora('Reorganizing codebase...').start();
    const result = await reorganize(reorganizeOptions);
    execSpinner.stop();

    if (result.success) {
      displayResult(result);
    } else {
      console.log(chalk.red('\nReorganization failed:\n'));
      for (const error of result.errors) {
        console.log(chalk.red(`  - ${error}`));
      }
      if (result.warnings.length > 0) {
        console.log(chalk.yellow('\nWarnings:'));
        for (const warning of result.warnings) {
          console.log(chalk.yellow(`  - ${warning}`));
        }
      }
      process.exit(1);
    }

  } catch (error) {
    if (progress.spinner) {
      progress.spinner.fail('Reorganization failed');
    } else {
      console.log(chalk.red('Reorganization failed'));
    }
    console.error(chalk.red(`\nError: ${error}\n`));
    process.exit(1);
  }
}

function displayReorganizationPreview(
  plan: ReorganizePlan,
  currentTree: string,
  proposedTree: string,
  safetyWarnings: string[] = [],
  tsconfigUpdates: Array<{ oldPath: string; newPath: string; alias: string }> = []
): void {
  // Header with box
  console.log('');
  console.log(chalk.cyan('╔══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║') + chalk.white.bold('                    REORGANIZATION PLAN                           ') + chalk.cyan('║'));
  console.log(chalk.cyan('╚══════════════════════════════════════════════════════════════════╝'));
  console.log('');

  // Impact summary box
  const riskColor = plan.riskLevel === 'LOW' ? chalk.green : plan.riskLevel === 'MEDIUM' ? chalk.yellow : chalk.red;
  const riskIcon = plan.riskLevel === 'LOW' ? '✓' : plan.riskLevel === 'MEDIUM' ? '!' : '⚠';

  console.log(chalk.gray('┌───────────────────────────────────┐'));
  console.log(chalk.gray('│') + chalk.white.bold(' Impact Summary                   ') + chalk.gray('│'));
  console.log(chalk.gray('├───────────────────────────────────┤'));
  console.log(chalk.gray('│') + `  Files to move:     ${chalk.cyan(String(plan.summary.filesToMove).padStart(4))}        ` + chalk.gray('│'));
  console.log(chalk.gray('│') + `  Import updates:    ${chalk.cyan(String(plan.summary.importsToRewrite).padStart(4))}        ` + chalk.gray('│'));
  console.log(chalk.gray('│') + `  New folders:       ${chalk.cyan(String(plan.summary.foldersToCreate.length).padStart(4))}        ` + chalk.gray('│'));
  console.log(chalk.gray('│') + `  Barrel files:      ${chalk.cyan(String(plan.summary.barrelFilesToCreate).padStart(4))}        ` + chalk.gray('│'));
  console.log(chalk.gray('│') + `  Risk level:     ${riskColor((riskIcon + ' ' + plan.riskLevel).padEnd(10))}    ` + chalk.gray('│'));
  console.log(chalk.gray('└───────────────────────────────────┘'));
  console.log('');

  // Domain-based summary with AI descriptions
  const domains = plan.domains || extractDomainsFromPlan(plan);
  if (domains.length > 0) {
    console.log(chalk.white.bold('Proposed Domain Structure:'));
    console.log('');
    for (const domain of domains) {
      console.log(chalk.cyan(`  📁 ${domain.name}/`));
      if ('description' in domain && domain.description) {
        console.log(chalk.gray(`     ${domain.description}`));
      }
      for (const file of domain.files.slice(0, 4)) {
        console.log(chalk.gray(`     └─ ${file}`));
      }
      if (domain.files.length > 4) {
        console.log(chalk.gray(`     └─ ... and ${domain.files.length - 4} more files`));
      }
    }
    console.log('');
  }

  // Compact side-by-side tree view (truncated)
  console.log(chalk.white.bold('Directory Structure (Before → After):'));
  console.log('');

  const currentLines = currentTree.split('\n').slice(0, 25);
  const proposedLines = proposedTree.split('\n').slice(0, 25);
  const maxLines = Math.max(currentLines.length, proposedLines.length);
  const colWidth = 35;

  console.log(chalk.gray('  CURRENT'.padEnd(colWidth + 2)) + chalk.gray('  PROPOSED'));
  console.log(chalk.gray('  ' + '─'.repeat(colWidth)) + chalk.gray('  ' + '─'.repeat(colWidth)));

  for (let i = 0; i < Math.min(maxLines, 20); i++) {
    const currentLine = (currentLines[i] || '').slice(0, colWidth).padEnd(colWidth);
    const proposedLine = (proposedLines[i] || '').slice(0, colWidth);

    console.log(
      chalk.gray('  ') +
      chalk.red(currentLine) +
      chalk.gray('  ') +
      chalk.green(proposedLine)
    );
  }

  if (maxLines > 20) {
    console.log(chalk.gray(`  ... ${maxLines - 20} more lines (use --json for full tree)`));
  }
  console.log('');

  // File moves detail with import changes
  const moves = plan.operations.filter(
    (op): op is Extract<typeof op, { type: 'move-file' }> => op.type === 'move-file'
  );

  if (moves.length > 0) {
    console.log(chalk.white('File Moves:'));
    for (const op of moves.slice(0, 15)) {
      console.log(chalk.red(`  - ${op.from}`));
      console.log(chalk.green(`    → ${op.to}`));

      // Show AI reason for this move
      if (op.reason) {
        console.log(chalk.yellow(`      Reason: ${op.reason}`));
      }

      // Show import updates for this file (limit to 3)
      if (op.importUpdates.length > 0) {
        const uniqueFiles = [...new Set(op.importUpdates.map(u => u.file))];
        const displayCount = Math.min(uniqueFiles.length, 3);
        console.log(chalk.gray(`      Updates ${uniqueFiles.length} import(s):`));
        for (const file of uniqueFiles.slice(0, displayCount)) {
          const shortFile = file.split('/').slice(-2).join('/');
          console.log(chalk.gray(`        ${shortFile}`));
        }
        if (uniqueFiles.length > displayCount) {
          console.log(chalk.gray(`        ... and ${uniqueFiles.length - displayCount} more`));
        }
      }
    }
    if (moves.length > 15) {
      console.log(chalk.gray(`  ... and ${moves.length - 15} more moves`));
    }
    console.log('');
  }

  // Import diff preview (sample)
  displayImportDiffPreview(moves.slice(0, 5));

  // Safety warnings
  if (safetyWarnings.length > 0) {
    console.log(chalk.yellow('Safety Warnings:'));
    for (const warning of safetyWarnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
    console.log('');
  }

  // tsconfig updates needed
  if (tsconfigUpdates.length > 0) {
    console.log(chalk.cyan('Suggested tsconfig.json Updates:'));
    for (const update of tsconfigUpdates.slice(0, 5)) {
      console.log(chalk.gray(`  "${update.alias}":`));
      console.log(chalk.red(`    - "${update.oldPath}"`));
      console.log(chalk.green(`    + "${update.newPath}"`));
    }
    if (tsconfigUpdates.length > 5) {
      console.log(chalk.gray(`  ... and ${tsconfigUpdates.length - 5} more`));
    }
    console.log('');
  }

  // AI reasoning
  if (plan.reasoning) {
    console.log(chalk.white('AI Reasoning:'));
    console.log(chalk.gray(`  ${plan.reasoning}\n`));
  }
}

function displayImportDiffPreview(
  moves: Array<{ from: string; to: string; importUpdates: Array<{ file: string; oldSource: string; newSource: string }> }>
): void {
  // Collect all import changes, filtering out unchanged paths
  const allChanges: Array<{ file: string; oldSource: string; newSource: string }> = [];
  for (const move of moves) {
    for (const update of move.importUpdates) {
      // Only include if the path actually changes
      if (update.oldSource !== update.newSource) {
        allChanges.push(update);
      }
    }
  }

  if (allChanges.length === 0) return;

  // Group by file
  const byFile = new Map<string, Array<{ oldSource: string; newSource: string }>>();
  for (const change of allChanges) {
    const shortFile = change.file.split('/').slice(-3).join('/');
    if (!byFile.has(shortFile)) {
      byFile.set(shortFile, []);
    }
    // Dedupe
    const existing = byFile.get(shortFile)!;
    if (!existing.some(e => e.oldSource === change.oldSource && e.newSource === change.newSource)) {
      existing.push({ oldSource: change.oldSource, newSource: change.newSource });
    }
  }

  console.log(chalk.white('Import Changes Preview:'));
  console.log(chalk.gray('  (showing files with import path changes)\n'));

  let fileCount = 0;
  for (const [file, changes] of byFile) {
    if (fileCount >= 5) {
      console.log(chalk.gray(`  ... and ${byFile.size - fileCount} more files\n`));
      break;
    }
    console.log(chalk.cyan(`  ${file}:`));
    for (const change of changes.slice(0, 3)) {
      console.log(chalk.red(`    - import ... from '${change.oldSource}'`));
      console.log(chalk.green(`    + import ... from '${change.newSource}'`));
    }
    if (changes.length > 3) {
      console.log(chalk.gray(`    ... and ${changes.length - 3} more changes`));
    }
    console.log('');
    fileCount++;
  }
}

function displayConflicts(conflicts: ReorganizeConflict[]): void {
  console.log(chalk.yellow('\n=== Conflicts Detected ===\n'));

  for (const conflict of conflicts) {
    const icon = conflict.type === 'entry-point' ? '⚠️' : '❌';
    console.log(chalk.yellow(`${icon} ${conflict.description}`));
    console.log(chalk.gray(`   Files: ${conflict.files.join(', ')}`));
    if (conflict.resolution) {
      console.log(chalk.gray(`   Resolution: ${conflict.resolution}`));
    }
    console.log('');
  }
}

async function interactiveApproval(plan: ReorganizePlan): Promise<string[]> {
  const moves = plan.operations.filter(op => op.type === 'move-file');
  const approved: string[] = [];

  console.log(chalk.cyan('\n=== Interactive Approval ===\n'));
  console.log(chalk.gray('Review each file move. Press Enter to approve, n to skip.\n'));

  for (const op of moves) {
    if (op.type !== 'move-file') continue;

    const { approve } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'approve',
        message: `Move ${chalk.red(op.from)} → ${chalk.green(op.to)}?`,
        default: true,
      },
    ]);

    if (approve) {
      approved.push(op.from);
    }
  }

  console.log(chalk.gray(`\nApproved ${approved.length} of ${moves.length} moves.\n`));
  return approved;
}

function displayResult(result: import('../refactor/types.js').ReorganizeResult): void {
  console.log(chalk.green('\n=== Reorganization Complete ===\n'));

  console.log(chalk.white('Summary:'));
  console.log(chalk.gray(`  Files moved:        ${chalk.green(result.movedFiles.length)}`));
  console.log(chalk.gray(`  Imports updated:    ${chalk.green(result.updatedImports.length)}`));
  console.log(chalk.gray(`  Barrel files:       ${chalk.green(result.createdBarrels.length)}`));
  console.log('');

  if (result.movedFiles.length > 0 && result.movedFiles.length <= 10) {
    console.log(chalk.white('Moved Files:'));
    for (const move of result.movedFiles) {
      console.log(chalk.green(`  ✓ ${move.from} → ${move.to}`));
    }
    console.log('');
  }

  if (result.createdBarrels.length > 0) {
    console.log(chalk.white('Created Barrel Files:'));
    for (const barrel of result.createdBarrels) {
      console.log(chalk.blue(`  + ${barrel}`));
    }
    console.log('');
  }

  if (result.warnings.length > 0) {
    console.log(chalk.yellow('Warnings:'));
    for (const warning of result.warnings) {
      console.log(chalk.yellow(`  ⚠ ${warning}`));
    }
    console.log('');
  }

  console.log(chalk.gray('Tip: Run `npm run build` to verify everything compiles.\n'));
  console.log(chalk.gray('Tip: Run `consuela verify` to check structural integrity.\n'));
}

/**
 * Extract domain groupings from the plan for visualization
 */
function extractDomainsFromPlan(plan: ReorganizePlan): Array<{ name: string; files: string[] }> {
  const domains = new Map<string, string[]>();

  for (const op of plan.operations) {
    if (op.type === 'move-file') {
      // Extract the first directory after src/ as the domain
      const parts = op.to.split('/');
      const srcIndex = parts.indexOf('src');
      if (srcIndex >= 0 && parts.length > srcIndex + 1) {
        const domainName = parts[srcIndex + 1];
        const fileName = parts[parts.length - 1];

        if (!domains.has(domainName)) {
          domains.set(domainName, []);
        }
        domains.get(domainName)!.push(fileName);
      }
    }
  }

  return Array.from(domains.entries())
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files.length - a.files.length);
}
