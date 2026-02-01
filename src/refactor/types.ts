

// ============================================================================
// Import/Export Location Types
// ============================================================================

/** Style of import statement */
export type ImportStyle =
  | 'named'           // import { foo } from './mod'
  | 'default'         // import foo from './mod'
  | 'namespace'       // import * as foo from './mod'
  | 'side-effect'     // import './mod'
  | 'dynamic'         // import('./mod')
  | 're-export'       // export { foo } from './mod'
  | 're-export-all';  // export * from './mod'

/** Whether import is type-only */
export type ImportKind = 'value' | 'type' | 'typeof';

/** Location of an import statement in a file */
export interface ImportLocation {
  /** Absolute path of the file containing the import */
  filePath: string;
  /** Line number where the import starts (1-based) */
  line: number;
  /** Column where the import starts (0-based) */
  column: number;
  /** End line of the import statement */
  endLine: number;
  /** End column of the import statement */
  endColumn: number;
  /** Start offset in the file */
  startOffset: number;
  /** End offset in the file */
  endOffset: number;
  /** The original import source path (e.g., './utils') */
  source: string;
  /** The resolved absolute path of the imported module (relative to root) */
  resolvedPath?: string;
  /** Style of this import */
  style: ImportStyle;
  /** Whether this is a type-only import */
  kind: ImportKind;
  /** Imported symbols (for named/namespace imports) */
  symbols: ImportedSymbol[];
  /** The full original import text */
  originalText: string;
}

/** A single symbol being imported */
export interface ImportedSymbol {
  /** Original exported name */
  name: string;
  /** Local alias (if renamed) */
  alias?: string;
  /** Whether this specific symbol is type-only */
  isTypeOnly: boolean;
}

// ============================================================================
// Refactor Operation Types
// ============================================================================

/** Base type for all refactoring operations */
interface RefactorOperationBase {
  /** Human-readable description of what this operation does */
  description: string;
  /** Whether to perform a dry-run (preview only) */
  dryRun?: boolean;
}

/** Describes how a symbol should be changed in an import */
export interface SymbolChange {
  /** Original symbol name */
  oldName: string;
  /** New symbol name (null = remove) */
  newName: string | null;
  /** New alias (if being renamed locally) */
  newAlias?: string;
}

// ============================================================================
// Import Change Types
// ============================================================================

/** Describes a single import that needs to be rewritten */
export interface ImportChange {
  /** File containing the import to change */
  filePath: string;
  /** Original import source path */
  oldSource: string;
  /** New import source path (null = remove import) */
  newSource: string | null;
  /** Symbols that should be changed (null = all symbols) */
  symbolChanges?: SymbolChange[];
  /** Location details for precise editing */
  location: ImportLocation;
}// ============================================================================
// File Change Types
// ============================================================================

/** Describes a change to be made to a file */
export interface FileChange {
  /** Absolute path to the file */
  filePath: string;
  /** Type of change */
  changeType: 'create' | 'modify' | 'delete' | 'rename';
  /** Original content (for verification/rollback) */
  originalContent?: string;
  /** New content after the change */
  newContent?: string;
  /** New file path (for rename operations) */
  newPath?: string;
  /** Description of the change */
  description: string;
  /** Edits to apply (for modify operations - alternative to full newContent) */
  edits?: TextEdit[];
}

/** A single text edit to apply to a file */
export interface TextEdit {
  /** Start offset in the file */
  startOffset: number;
  /** End offset in the file */
  endOffset: number;
  /** New text to insert */
  newText: string;
  /** Human-readable description of the edit */
  description?: string;
}/**
 * Export conflict information
 */
export interface ExportConflict {
  /** Name of the conflicting export */
  name: string;
  /** Files that export the same name */
  sources: string[];
  /** Type of export (function, class, etc.) */
  kind: string;
}

// ============================================================================
// Import Rewriter Config
// ============================================================================

/** Configuration for import rewriting operations */
export interface ImportRewriterConfig {
  /** Root directory of the project */
  rootDir: string;
  /** Patterns to ignore */
  ignore?: string[];
  /** Whether this is a dry run */
  dryRun?: boolean;
  /** TypeScript path aliases (from tsconfig) */
  pathAliases?: Map<string, string[]>;
}

// ============================================================================
// Cleanup Types
// ============================================================================

/** Information about a removed export */
export interface RemovedExport {
  /** File the export was in */
  file: string;
  /** Name of the export */
  name: string;
  /** Kind of export (function, class, type, etc.) */
  kind: string;
  /** Line number */
  line: number;
  /** Reason for removal */
  reason: string;
}

/** Information about consolidated duplicates */
export interface ConsolidatedDuplicate {
  /** The export that was kept */
  kept: string;
  /** Exports that were removed */
  removed: string[];
  /** Name of the function/export */
  name: string;
}

// ============================================================================
// Split Types
// ============================================================================

/** Preview of a split operation */
export interface SplitPreview {
  /** New content for source file */
  sourceContent: string;
  /** Content for the new target file */
  targetContent: string;
  /** Map of external file updates */
  externalUpdates: Map<string, string>;
}

// ============================================================================
// Auto-fix Types
// ============================================================================

/** Options for auto-fix operations */
export interface AutoFixOptions {
  /** Maximum iterations to run */
  maxIterations?: number;
  /** Preview changes without applying */
  dryRun?: boolean;
  /** Show detailed progress */
  verbose?: boolean;
  /** More aggressive refactoring */
  aggressive?: boolean;
  /** Skip structural verification */
  skipVerify?: boolean;
  /** Enable git integration (commits after each action, rollback on failure). Default: true */
  git?: boolean;
  /** Enable build verification after each change. Default: true */
  verify?: boolean;
}

/** A fix action to be applied */
export interface FixAction {
  /** Type of action */
  type: 'cleanup' | 'split' | 'merge' | 'skip';
  /** Reason for this action */
  reason: string;
  /** Target file (for split/merge) */
  target?: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

// ============================================================================
// Merge Types
// ============================================================================

/** Options for merge operations */
export interface MergeOptions {
  /** Source files to merge */
  sources: string[];
  /** Target file to merge into */
  target: string;
  /** Whether to delete original files after merge */
  deleteOriginals?: boolean;
  /** Preview changes without applying */
  dryRun?: boolean;
  /** Root directory */
  rootDir?: string;
}

/** Import update needed for a file move */
export interface ImportUpdate {
  /** File containing the import */
  file: string;
  /** Old import source */
  oldSource: string;
  /** New import source */
  newSource: string;
}

/** Single operation in a reorganization plan */
export type ReorganizeOperation =
  | { type: 'create-folder'; path: string }
  | { type: 'move-file'; from: string; to: string; importUpdates: ImportUpdate[]; reason?: string }
  | { type: 'create-barrel'; path: string; content: string }
  | { type: 'update-imports'; file: string; updates: ImportUpdate[] };

/** Conflict detected in reorganization plan */
export interface ReorganizeConflict {
  /** Type of conflict */
  type: 'name-collision' | 'circular-move' | 'entry-point' | 'missing-file';
  /** Description of the conflict */
  description: string;
  /** Files involved */
  files: string[];
  /** Suggested resolution */
  resolution?: string;
}

/** Domain metadata for display */
export interface DomainMetadata {
  /** Name of the domain */
  name: string;
  /** Target folder */
  folder: string;
  /** AI-generated description of what this domain handles */
  description?: string;
  /** Files in this domain */
  files: string[];
}

/** Complete reorganization plan */
export interface ReorganizePlan {
  /** Ordered list of operations to execute */
  operations: ReorganizeOperation[];
  /** Summary statistics */
  summary: {
    foldersToCreate: string[];
    filesToMove: number;
    importsToRewrite: number;
    barrelFilesToCreate: number;
  };
  /** Detected conflicts */
  conflicts: ReorganizeConflict[];
  /** Risk level */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** AI reasoning */
  reasoning?: string;
  /** Domain metadata with AI explanations */
  domains?: DomainMetadata[];
}

/** Options for reorganize command */
export interface ReorganizeOptions {
  /** Target directory to reorganize (default: entire project) */
  targetDir?: string;
  /** Preview only, don't apply changes */
  dryRun?: boolean;
  /** Approve each move interactively */
  interactive?: boolean;
  /** More aggressive restructuring */
  aggressive?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Output as JSON */
  json?: boolean;
  /** Root directory */
  rootDir?: string;
  /** Glob patterns to exclude from reorganization */
  exclude?: string[];
  /** Create backup before applying changes */
  backup?: boolean;
}

/** Result of a reorganization */
export interface ReorganizeResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** The executed plan */
  plan: ReorganizePlan;
  /** Files that were moved */
  movedFiles: Array<{ from: string; to: string }>;
  /** Files that had imports updated */
  updatedImports: string[];
  /** Barrel files created */
  createdBarrels: string[];
  /** Errors encountered */
  errors: string[];
  /** Warnings */
  warnings: string[];
}

// ============================================================================
// Command Option Types
// ============================================================================

/** Options for the cleanup command */
export interface CleanupCommandOptions {
  /** Remove unused exports */
  unused?: boolean;
  /** Remove duplicates */
  duplicates?: boolean;
  /** Remove all dead code */
  all?: boolean;
  /** Preview without making changes */
  dryRun?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Output as JSON */
  json?: boolean;
}

/** Options for the merge command */
export interface MergeCommandOptions {
  /** Target file to merge into */
  into: string;
  /** Preview without making changes */
  dryRun?: boolean;
  /** Output as JSON */
  json?: boolean;
  /** Keep original files */
  keepOriginals?: boolean;
}