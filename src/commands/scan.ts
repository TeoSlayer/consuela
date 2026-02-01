/**
 * scan command - Generate the "Gold Standard" function graph
 * This captures the structural shape of the codebase that must be preserved
 */

import chalk from 'chalk';
import ora from 'ora';
import { createGraphAnalyzer, serializeGraph } from '../graph/index.js';

interface ScanOptions {
  json?: boolean;
  output?: string;
}

export async function scanCommand(options: ScanOptions): Promise<void> {
  const spinner = ora('Scanning codebase for function graph...').start();

  try {
    const analyzer = createGraphAnalyzer();
    const graph = await analyzer.buildGraph();

    spinner.succeed('Graph extraction complete');

    if (options.json) {
      console.log(JSON.stringify(serializeGraph(graph), null, 2));
      return;
    }

    // Save as Gold Standard
    analyzer.saveGoldStandard(graph);

    console.log(chalk.cyan('\n📊 Function Graph Summary\n'));
    console.log(chalk.gray('─'.repeat(50)));
    console.log(`  Files analyzed:      ${chalk.white(graph.files.length)}`);
    console.log(`  Total functions:     ${chalk.white(graph.stats.totalFunctions)}`);
    console.log(`  Exported functions:  ${chalk.white(graph.stats.exportedFunctions)}`);
    console.log(`  Total call edges:    ${chalk.white(graph.stats.totalCalls)}`);
    console.log(chalk.gray('─'.repeat(50)));

    console.log(chalk.cyan('\n🧪 Purity Analysis\n'));
    console.log(`  ${chalk.green('Pure functions:')}     ${graph.stats.pureFunctions}`);
    console.log(`  ${chalk.red('Impure functions:')}   ${graph.stats.impureFunctions}`);

    if (graph.stats.impureFunctions > 0) {
      const pureRatio = (graph.stats.pureFunctions / graph.stats.totalFunctions * 100).toFixed(1);
      console.log(`  ${chalk.gray('Purity ratio:')}       ${pureRatio}%`);
    }

    console.log(chalk.green('\n✓ Gold Standard saved to .consuela/graph.json'));
    console.log(chalk.gray('  Use `consuela verify` to check for structural changes.\n'));

  } catch (error) {
    spinner.fail('Scan failed');
    console.error(chalk.red(`Error: ${error}`));
    process.exit(1);
  }
}
