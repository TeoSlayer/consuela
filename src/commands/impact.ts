import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import { createConfiguredAnalyzer, type ProjectAnalysis, type SymbolTrace } from '../core/index.js';

interface ImpactOptions {
  json?: boolean;
}

export async function impactCommand(filePath: string, options: ImpactOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    const relativePath = path.relative(process.cwd(), path.resolve(process.cwd(), filePath));
    const fileAnalysis = analysis.files.get(relativePath);

    if (!fileAnalysis) {
      console.log(chalk.red(`\nFile not found in analysis: ${relativePath}`));
      console.log(chalk.gray('Make sure the file exists and is not in the blacklist.\n'));
      process.exit(1);
    }

    // Get all files that would be affected
    const impactedFiles = analyzer.getImpact(analysis, filePath);

    // Get exports from this file and their traces
    const exportTraces: SymbolTrace[] = [];
    for (const exp of fileAnalysis.exports) {
      const trace = analysis.symbolTraces.get(`${relativePath}:${exp.name}`);
      if (trace) {
        exportTraces.push(trace);
      }
    }

    if (options.json) {
      console.log(JSON.stringify({
        file: relativePath,
        exports: fileAnalysis.exports,
        directDependents: Array.from(analysis.reverseGraph.get(relativePath) || []),
        allImpacted: impactedFiles,
        exportTraces: exportTraces.map((t) => ({
          name: t.symbol.name,
          usageCount: t.usageCount,
          dependents: t.dependents,
        })),
      }, null, 2));
      return;
    }

    printImpact(relativePath, fileAnalysis, impactedFiles, exportTraces, analysis);
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function printImpact(
  filePath: string,
  fileAnalysis: { exports: Array<{ name: string; kind: string; line: number }> },
  impactedFiles: string[],
  exportTraces: SymbolTrace[],
  analysis: ProjectAnalysis
): void {
  console.log(chalk.cyan(`\n💥 Impact Analysis: ${filePath}\n`));
  console.log(chalk.gray('─'.repeat(50)));

  // Direct dependents
  const directDependents = analysis.reverseGraph.get(filePath) || new Set();
  console.log(chalk.white(`\n  Direct dependents (${directDependents.size}):`));

  if (directDependents.size === 0) {
    console.log(chalk.gray('    No files directly import this module'));
  } else {
    for (const dep of directDependents) {
      console.log(`    ${chalk.blue(dep)}`);
    }
  }

  // Transitive impact
  const transitiveOnly = impactedFiles.filter((f) => !directDependents.has(f));
  if (transitiveOnly.length > 0) {
    console.log(chalk.white(`\n  Transitive impact (${transitiveOnly.length} additional files):`));
    for (const dep of transitiveOnly.slice(0, 10)) {
      console.log(`    ${chalk.yellow(dep)}`);
    }
    if (transitiveOnly.length > 10) {
      console.log(chalk.gray(`    ... and ${transitiveOnly.length - 10} more`));
    }
  }

  // Export breakdown
  console.log(chalk.white(`\n  Exports from this file (${fileAnalysis.exports.length}):`));

  if (fileAnalysis.exports.length === 0) {
    console.log(chalk.gray('    No exports'));
  } else {
    // Sort by usage count
    const sorted = [...exportTraces].sort((a, b) => b.usageCount - a.usageCount);

    for (const trace of sorted) {
      const usageLabel = trace.usageCount === 0
        ? chalk.gray('(unused)')
        : chalk.green(`(${trace.usageCount} usages)`);
      const impactLabel = trace.dependents.length > 0
        ? chalk.yellow(`→ ${trace.dependents.length} files`)
        : '';

      console.log(`    ${chalk.white(trace.symbol.name)} ${usageLabel} ${impactLabel}`);
    }
  }

  // Risk assessment
  console.log(chalk.gray('\n' + '─'.repeat(50)));
  console.log(chalk.white('\n  Risk Assessment:'));

  const totalImpact = impactedFiles.length;
  const highUsageExports = exportTraces.filter((t) => t.usageCount > 5).length;

  if (totalImpact === 0) {
    console.log(chalk.green('    ✓ LOW RISK - No other files depend on this'));
  } else if (totalImpact <= 3) {
    console.log(chalk.green(`    ✓ LOW RISK - Only ${totalImpact} files affected`));
  } else if (totalImpact <= 10) {
    console.log(chalk.yellow(`    ⚠ MEDIUM RISK - ${totalImpact} files affected`));
  } else {
    console.log(chalk.red(`    ✗ HIGH RISK - ${totalImpact} files affected`));
  }

  if (highUsageExports > 0) {
    console.log(chalk.yellow(`    ⚠ ${highUsageExports} exports have >5 usages each`));
  }

  // Recommendations
  console.log(chalk.white('\n  Recommendations:'));
  if (totalImpact === 0) {
    console.log(chalk.gray('    Safe to modify or delete'));
  } else {
    console.log(chalk.gray('    - Review all impacted files before changing'));
    console.log(chalk.gray('    - Consider adding deprecation warnings first'));
    console.log(chalk.gray(`    - Use \`consuela trace <export>\` for detailed usage`));
  }

  console.log('');
}
