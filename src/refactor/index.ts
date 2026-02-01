/**
 * Refactoring Module
 *
 * Provides safe, automated code refactoring capabilities for the Consuela CLI.
 */

// Core types from types.ts
export type {
  ImportStyle,
  ImportKind,
  ImportLocation,
  ImportedSymbol,
  ImportChange,
  FileChange,
  TextEdit,
  ExportConflict,
  SymbolChange,
  ImportRewriterConfig,
  RemovedExport,
  ConsolidatedDuplicate,
  SplitPreview,
  AutoFixOptions,
  FixAction,
  MergeOptions,
  CleanupCommandOptions,
  MergeCommandOptions,
} from './types.js';

// Import rewriter functions
export {
  findFilesImporting,
  calculateRelativeImport,
} from './import-rewriter.js';

// Operations
export * from './operations/index.js';
