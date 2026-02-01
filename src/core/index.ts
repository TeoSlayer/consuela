// Core exports
export { createAnalyzer, type ProjectAnalyzer } from './analyzer.js';
export type { ExportInfo, SymbolTrace, ProjectAnalysis, UnusedExport, BreakingChange } from './analyzer.js';
export { loadProjectConfig, mergeWithDefaults } from './config.js';
export type { ConsuelaConfig } from './config.js';
export { createGeminiClient } from './gemini.js';
export type { TidyContext } from './gemini.js';

import { createAnalyzer, type ProjectAnalyzer } from './analyzer.js';
import { loadProjectConfig, mergeWithDefaults } from './config.js';

/**
 * Create an analyzer with project config automatically loaded
 */
export function createConfiguredAnalyzer(rootDir: string = process.cwd()): ProjectAnalyzer {
  const projectConfig = loadProjectConfig(rootDir);
  const config = mergeWithDefaults(projectConfig);

  return createAnalyzer(rootDir, undefined, {
    ignore: config.ignore,
    entryPoints: config.entryPoints,
    cache: config.cache,
  });
}
