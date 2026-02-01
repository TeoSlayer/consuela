import chalk from 'chalk';
import ora from 'ora';
import { createConfiguredAnalyzer, type ProjectAnalyzer, type ProjectAnalysis, type SymbolTrace, type UnusedExport } from '../core/index.js';

interface MapOptions {
  json?: boolean;
  file?: string; // Focus on specific file
  depth?: string; // How deep to trace (1, 2, 3, or "all")
}

export async function mapCommand(options: MapOptions): Promise<void> {
  const spinner = ora('Analyzing codebase...').start();

  try {
    const analyzer = createConfiguredAnalyzer();
    const analysis = await analyzer.analyze();

    spinner.succeed('Analysis complete');

    const depthNum = options.depth ? parseInt(options.depth, 10) : 2;

    if (options.json) {
      const output = buildMapOutput(analysis, analyzer, options.file, depthNum);
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    printMap(analysis, analyzer, options.file, depthNum);
  } catch (error) {
    spinner.fail('Analysis failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}

function buildMapOutput(
  analysis: ProjectAnalysis,
  analyzer: ProjectAnalyzer,
  focusFile?: string,
  depth: number = 2
): object {
  const files: Array<{
    path: string;
    exports: Array<{
      name: string;
      kind: string;
      signature?: string;
      usageCount: number;
      usedBy: string[];
    }>;
    imports: Array<{
      name: string;
      from: string;
      resolvedPath?: string;
    }>;
    dependsOn: string[];
    dependedOnBy: string[];
  }> = [];

  // If focus file specified, only include it and its dependencies
  const filesToInclude = focusFile
    ? getRelatedFiles(analysis, focusFile, depth)
    : Array.from(analysis.files.keys());

  for (const filePath of filesToInclude) {
    const fileAnalysis = analysis.files.get(filePath);
    if (!fileAnalysis) continue;

    const exports = fileAnalysis.exports
      .filter(e => e.name !== '*')
      .map(exp => {
        const trace = analysis.symbolTraces.get(`${filePath}:${exp.name}`);
        return {
          name: exp.name,
          kind: exp.kind,
          signature: exp.signature,
          usageCount: trace?.usageCount || 0,
          usedBy: trace?.importedBy.map(i => i.file) || [],
        };
      });

    const imports = fileAnalysis.imports.map(imp => ({
      name: imp.name,
      from: imp.source,
      resolvedPath: imp.resolvedPath,
    }));

    const dependsOn = Array.from(analysis.importGraph.get(filePath) || []);
    const dependedOnBy = Array.from(analysis.reverseGraph.get(filePath) || []);

    files.push({
      path: filePath,
      exports,
      imports,
      dependsOn,
      dependedOnBy,
    });
  }

  // Summary stats
  const totalExports = Array.from(analysis.symbolTraces.values()).length;
  const unusedExports = analyzer.findUnusedExports(analysis).filter((u: UnusedExport) => !u.reason.includes('Entry point'));

  return {
    summary: {
      totalFiles: analysis.files.size,
      totalExports,
      unusedExports: unusedExports.length,
      circularDependencies: analysis.circularDependencies.length,
    },
    circularDependencies: analysis.circularDependencies,
    files,
    // High-level dependency graph for quick understanding
    dependencyGraph: buildSimpleDependencyGraph(analysis),
  };
}

function getRelatedFiles(
  analysis: ProjectAnalysis,
  focusFile: string,
  depth: number
): string[] {
  const related = new Set<string>();
  related.add(focusFile);

  let frontier = [focusFile];

  for (let d = 0; d < depth; d++) {
    const nextFrontier: string[] = [];

    for (const file of frontier) {
      // Add files this depends on
      const deps = analysis.importGraph.get(file);
      if (deps) {
        for (const dep of deps) {
          if (!related.has(dep)) {
            related.add(dep);
            nextFrontier.push(dep);
          }
        }
      }

      // Add files that depend on this
      const dependents = analysis.reverseGraph.get(file);
      if (dependents) {
        for (const dep of dependents) {
          if (!related.has(dep)) {
            related.add(dep);
            nextFrontier.push(dep);
          }
        }
      }
    }

    frontier = nextFrontier;
  }

  return Array.from(related);
}

function buildSimpleDependencyGraph(
  analysis: ProjectAnalysis
): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  for (const [file, deps] of analysis.importGraph) {
    if (deps.size > 0) {
      graph[file] = Array.from(deps);
    }
  }

  return graph;
}

function printMap(
  analysis: ProjectAnalysis,
  analyzer: ProjectAnalyzer,
  focusFile?: string,
  _depth: number = 2
): void {
  console.log(chalk.cyan('\n🗺️  Codebase Map\n'));
  console.log(chalk.gray('─'.repeat(60)));

  // Summary
  const totalExports = Array.from(analysis.symbolTraces.values()).length;
  const unusedExports = analyzer.findUnusedExports(analysis).filter((u: UnusedExport) => !u.reason.includes('Entry point'));

  console.log(chalk.white('\n  Overview:'));
  console.log(`    Files:        ${analysis.files.size}`);
  console.log(`    Exports:      ${totalExports}`);
  console.log(`    Unused:       ${unusedExports.length > 0 ? chalk.yellow(unusedExports.length) : chalk.green('0')}`);
  console.log(`    Circular:     ${analysis.circularDependencies.length > 0 ? chalk.yellow(analysis.circularDependencies.length) : chalk.green('0')}`);

  // Most connected files (hubs)
  const filesByConnections = Array.from(analysis.files.keys())
    .map(file => {
      const deps = analysis.importGraph.get(file)?.size || 0;
      const dependents = analysis.reverseGraph.get(file)?.size || 0;
      return { file, deps, dependents, total: deps + dependents };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  console.log(chalk.white('\n  Key Files (most connected):'));
  for (const { file, deps, dependents } of filesByConnections) {
    if (deps + dependents > 0) {
      console.log(`    ${chalk.green(file)}`);
      console.log(chalk.gray(`      imports ${deps} files, imported by ${dependents} files`));
    }
  }

  // Most used exports
  const topExports = Array.from(analysis.symbolTraces.values())
    .filter((t: SymbolTrace) => t.symbol.name !== '*')
    .sort((a: SymbolTrace, b: SymbolTrace) => b.usageCount - a.usageCount)
    .slice(0, 5);

  if (topExports.length > 0 && topExports[0].usageCount > 0) {
    console.log(chalk.white('\n  Most Used Exports:'));
    for (const trace of topExports) {
      if (trace.usageCount > 0) {
        console.log(`    ${chalk.blue(trace.symbol.name)} ${chalk.gray(`(${trace.usageCount} usages)`)}`);
        console.log(chalk.gray(`      from ${trace.symbol.filePath}`));
      }
    }
  }

  // Focus file details
  if (focusFile) {
    const fileAnalysis = analysis.files.get(focusFile);
    if (fileAnalysis) {
      console.log(chalk.white(`\n  Focus: ${focusFile}`));
      console.log(chalk.gray('  ' + '─'.repeat(50)));

      console.log(chalk.white('    Exports:'));
      for (const exp of fileAnalysis.exports.filter(e => e.name !== '*')) {
        const trace = analysis.symbolTraces.get(`${focusFile}:${exp.name}`);
        const usage = trace?.usageCount || 0;
        console.log(`      ${chalk.green(exp.name)} [${exp.kind}] - ${usage} usages`);
      }

      console.log(chalk.white('    Imports from:'));
      const deps = analysis.importGraph.get(focusFile);
      if (deps && deps.size > 0) {
        for (const dep of deps) {
          console.log(`      ${chalk.blue(dep)}`);
        }
      } else {
        console.log(chalk.gray('      (none)'));
      }

      console.log(chalk.white('    Imported by:'));
      const dependents = analysis.reverseGraph.get(focusFile);
      if (dependents && dependents.size > 0) {
        for (const dep of dependents) {
          console.log(`      ${chalk.yellow(dep)}`);
        }
      } else {
        console.log(chalk.gray('      (none)'));
      }
    }
  }

  console.log('\n' + chalk.gray('─'.repeat(60)));
  console.log(chalk.gray('  Use --json for machine-readable output'));
  console.log(chalk.gray('  Use --file <path> to focus on a specific file'));
  console.log('');
}
