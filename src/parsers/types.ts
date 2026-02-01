/**
 * Language-agnostic types for multi-language support
 */

/** The kind of exported symbol */
export type ExportKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'type'
  | 'interface'
  | 'constant'
  | 'enum'
  | 'module'
  | 'unknown';

/** Language-agnostic export information */
export interface Export {
  name: string;
  kind: ExportKind;
  filePath: string;
  line: number;
  isDefault?: boolean;
  isReExport?: boolean;
  originalSource?: string;
  signature?: string;
}

/** Language-agnostic import information */
export interface Import {
  name: string;
  alias?: string;
  source: string;
  resolvedPath?: string;
  filePath: string;
  line: number;
  isDefault?: boolean;
}

/** Symbol usage information */
export interface Usage {
  filePath: string;
  line: number;
  context: string;
  type: 'call' | 'reference' | 'extend' | 'implement' | 'spread' | 'assign' | 'pass' | 'return';
}

/** Local symbol mapping (for tracking aliases) */
export interface LocalSymbol {
  source: string;
  originalName: string;
}

/** Result of parsing a single file */
export interface FileParseResult {
  filePath: string;
  exports: Export[];
  imports: Import[];
  localSymbols: Map<string, LocalSymbol>;
}

/** Configuration for import resolution */
export interface ResolverConfig {
  rootDir: string;
  baseUrl?: string;
  pathAliases?: Map<string, string[]>;
  extensions?: string[];
}

/**
 * Interface that all language parsers must implement
 */
export interface LanguageParser {
  /** Unique identifier for this parser */
  readonly id: string;

  /** Human-readable name */
  readonly name: string;

  /** File extensions this parser handles (e.g., ['.ts', '.tsx']) */
  readonly extensions: string[];

  /**
   * Parse a single file and extract exports/imports
   */
  parseFile(filePath: string, content: string): FileParseResult;

  /**
   * Resolve an import specifier to an absolute file path
   */
  resolveImport(
    importSource: string,
    fromFile: string,
    config: ResolverConfig
  ): string | undefined;

  /**
   * Find all usages of a symbol within a file
   */
  findUsages(
    filePath: string,
    content: string,
    symbolName: string,
    localSymbols: Map<string, LocalSymbol>
  ): Usage[];

  /**
   * Get language-specific prompts for the tidy command
   */
  getTidyPrompt?(): string;
}
