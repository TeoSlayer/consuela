import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'node:fs';
import * as path from 'node:path';
import inquirer from 'inquirer';
import { getGlobalApiKey, hasGlobalApiKey } from './config.js';
import { createGeminiClient, type TidyContext } from '../core/gemini.js';
import { createConfiguredAnalyzer } from '../core/index.js';
import { createGraphAnalyzer } from '../graph/index.js';

interface TidyOptions {
  apply?: boolean;
  dryRun?: boolean;
  skipVerify?: boolean;
}

export async function tidyCommand(filePath: string, options: TidyOptions): Promise<void> {
  if (!hasGlobalApiKey()) {
    console.log(chalk.red('\nGemini API key not configured.'));
    console.log(chalk.gray('Run `consuela config` to set up AI features.\n'));
    process.exit(1);
  }

  const apiKey = getGlobalApiKey()!;

  // Resolve file path
  const absolutePath = path.resolve(process.cwd(), filePath);
  const relativePath = path.relative(process.cwd(), absolutePath);

  if (!fs.existsSync(absolutePath)) {
    console.log(chalk.red(`\nFile not found: ${filePath}\n`));
    process.exit(1);
  }

  const fileContent = fs.readFileSync(absolutePath, 'utf-8');

  console.log(chalk.cyan(`\n🧹 Tidying: ${relativePath}\n`));

  const spinner = ora('Analyzing codebase for context...').start();

  try {
    // Analyze codebase to get context
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    // Build context for the AI
    const fileAnalysis = analysis.files.get(relativePath);
    const context: TidyContext = {};

    if (fileAnalysis) {
      // Get export info with usage counts
      context.exports = fileAnalysis.exports.map(exp => {
        const trace = analysis.symbolTraces.get(`${relativePath}:${exp.name}`);
        return {
          name: exp.name,
          kind: exp.kind,
          usageCount: trace?.usageCount || 0,
        };
      });

      // Get imports
      context.imports = fileAnalysis.imports.map(imp => ({
        name: imp.name,
        source: imp.source,
      }));

      // Get files that depend on this file
      const dependents = analysis.reverseGraph.get(relativePath);
      if (dependents) {
        context.dependents = Array.from(dependents);
      }

      // Find unused exports
      const unused = analyzer.findUnusedExports(analysis);
      context.unusedExports = unused
        .filter(u => u.export.filePath === relativePath && !u.reason.includes('Entry point'))
        .map(u => u.export.name);
    }

    spinner.text = 'Sending to Gemini for cleanup suggestions...';

    const gemini = createGeminiClient(apiKey);
    const result = await gemini.tidyCode(relativePath, fileContent, context);

    spinner.succeed('Received cleanup suggestions');

    if (!result.cleanedCode) {
      console.log(chalk.yellow('\nNo changes suggested.\n'));
      return;
    }

    // Structural verification against Gold Standard
    if (!options.skipVerify) {
      spinner.start('Verifying structural integrity...');

      try {
        const graphAnalyzer = createGraphAnalyzer();
        const goldStandard = graphAnalyzer.loadGoldStandard();

        if (goldStandard) {
          const verification = await graphAnalyzer.verifyFileChange(absolutePath, result.cleanedCode);

          if (!verification.valid) {
            spinner.warn('Structural changes detected');

            console.log(chalk.yellow('\n⚠ AI changes would break the Gold Standard:\n'));
            for (const summary of verification.diff.summary) {
              console.log(chalk.yellow(`  • ${summary}`));
            }

            if (verification.diff.removedFunctions.length > 0) {
              console.log(chalk.red('\n  Removed functions:'));
              for (const fn of verification.diff.removedFunctions.slice(0, 5)) {
                console.log(chalk.red(`    - ${fn}`));
              }
            }

            if (verification.diff.signatureChanges.length > 0) {
              console.log(chalk.yellow('\n  Signature changes:'));
              for (const change of verification.diff.signatureChanges.slice(0, 3)) {
                console.log(chalk.yellow(`    ~ ${change.id}`));
              }
            }

            console.log(chalk.gray('\n  The changes have been rejected to preserve structural integrity.'));
            console.log(chalk.gray('  Use --skip-verify to bypass this check (not recommended).\n'));
            return;
          }

          spinner.succeed('Structural integrity verified');
        } else {
          spinner.info('No Gold Standard found (run `consuela scan` to enable verification)');
        }
      } catch (error) {
        spinner.warn('Could not verify structure (continuing without verification)');
      }
    }

    // Show the changes
    console.log(chalk.cyan('\n📝 Suggested Changes:'));
    console.log(chalk.gray('─'.repeat(50)));
    for (const change of result.changes) {
      console.log(chalk.gray(`  • ${change}`));
    }

    if (result.reasoning) {
      console.log(chalk.cyan('\n💭 Reasoning:'));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.gray(`  ${result.reasoning}`));
    }

    // Show diff preview
    console.log(chalk.cyan('\n📄 Preview:'));
    console.log(chalk.gray('─'.repeat(50)));
    showSimpleDiff(fileContent, result.cleanedCode);

    if (options.dryRun) {
      console.log(chalk.gray('\n  Dry run - no changes made.\n'));
      return;
    }

    if (options.apply) {
      fs.writeFileSync(absolutePath, result.cleanedCode);
      console.log(chalk.green(`\n✓ Changes applied to: ${relativePath}\n`));
      return;
    }

    // Ask user
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Apply changes', value: 'apply' },
          { name: 'Save to .diff file', value: 'save' },
          { name: 'Discard', value: 'discard' },
        ],
      },
    ]);

    if (action === 'apply') {
      fs.writeFileSync(absolutePath, result.cleanedCode);
      console.log(chalk.green(`\n✓ Changes applied to: ${relativePath}\n`));
    } else if (action === 'save') {
      const diffPath = absolutePath + '.suggested';
      fs.writeFileSync(diffPath, result.cleanedCode);
      console.log(chalk.green(`\n✓ Saved to: ${diffPath}\n`));
      console.log(chalk.gray(`  Compare with: diff ${relativePath} ${relativePath}.suggested\n`));
    } else {
      console.log(chalk.gray('\n  Changes discarded.\n'));
    }
  } catch (error) {
    spinner.fail('Tidy failed');
    console.error(chalk.red(`\nError: ${error}\n`));
    process.exit(1);
  }
}

function showSimpleDiff(original: string, modified: string): void {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  let changes = 0;
  const maxChanges = 20;

  for (let i = 0; i < Math.max(originalLines.length, modifiedLines.length); i++) {
    if (changes >= maxChanges) {
      console.log(chalk.gray(`  ... and more changes`));
      break;
    }

    const orig = originalLines[i];
    const mod = modifiedLines[i];

    if (orig !== mod) {
      if (orig !== undefined && mod !== undefined) {
        // Changed line
        console.log(chalk.red(`  - ${orig.slice(0, 80)}`));
        console.log(chalk.green(`  + ${mod.slice(0, 80)}`));
        changes++;
      } else if (orig !== undefined) {
        // Removed line
        console.log(chalk.red(`  - ${orig.slice(0, 80)}`));
        changes++;
      } else if (mod !== undefined) {
        // Added line
        console.log(chalk.green(`  + ${mod.slice(0, 80)}`));
        changes++;
      }
    }
  }

  if (changes === 0) {
    console.log(chalk.gray('  No visible changes'));
  }
}
