/**
 * Import Rewriter - The critical piece for refactoring operations
 *
 * Handles finding and rewriting import statements across the codebase
 * when files are moved, merged, split, or renamed.
 *
 * Supports:
 * - Named imports: import { foo } from './old'
 * - Default imports: import foo from './old'
 * - Namespace imports: import * as old from './old'
 * - Side-effect imports: import './old'
 * - Re-exports: export { foo } from './old'
 * - Star re-exports: export * from './old'
 * - Dynamic imports: import('./old')
 * - Type-only imports: import type { Foo } from './old'
 * - TypeScript path aliases
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { glob } from 'glob';
import type {
  ImportLocation,
  ImportStyle,
  ImportKind,
  ImportedSymbol,
  ImportChange,
  TextEdit,
  ImportRewriterConfig,
} from './types.js';
import { applyTextEdits,  tryResolveWithExtensions, normalizeFilePath, getScriptKind, calculateRelativeImport } from './import-rewriter.helpers.js';

// Re-export for backwards compatibility
export { calculateRelativeImport };

// ============================================================================
// Source File Discovery
// ============================================================================

/**
 * Find all TypeScript/JavaScript source files in a directory
 */
async function findSourceFiles(
  rootDir: string,
  ignore: string[] = []
): Promise<string[]> {
  const defaultIgnore = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/*.d.ts',
    '**/coverage/**',
    '**/__tests__/**',
    '**/*.test.*',
    '**/*.spec.*',
    '**/fixtures/**',
    '**/test/**',
    '**/tests/**',
  ];

  const files = await glob('**/*.{ts,tsx,js,jsx,mjs}', {
    cwd: rootDir,
    absolute: true,
    ignore: [...defaultIgnore, ...ignore],
  });

  return files;
}

// ============================================================================
// Import Path Resolution
// ============================================================================

/**
 * Resolve an import path to an absolute file path
 */
function resolveImportPath(
  fileDir: string,
  importSource: string,
  config: ImportRewriterConfig
): string | undefined {
  // Handle non-relative imports
  if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
    // Check if it matches a path alias
    if (config.pathAliases) {
      for (const [alias, targets] of config.pathAliases) {
        const aliasPattern = alias.replace(/\*$/, '');
        if (importSource.startsWith(aliasPattern)) {
          const remainder = importSource.slice(aliasPattern.length);
          for (const targetDir of targets) {
            const targetPath = path.join(targetDir.replace(/\*$/, ''), remainder);
            const resolved = tryResolveWithExtensions(targetPath, ['.ts', '.tsx', '.js', '.jsx', '.mjs']);
            if (resolved) {
              return path.relative(config.rootDir, resolved);
            }
          }
        }
      }
    }
    // External package
    return undefined;
  }

  // Resolve relative import
  const absolutePath = path.resolve(fileDir, importSource);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

  // Try resolving with extensions
  const resolved = tryResolveWithExtensions(absolutePath, extensions);
  if (resolved) {
    return path.relative(config.rootDir, resolved);
  }

  // Try as directory with index file
  for (const ext of extensions) {
    const indexPath = path.join(absolutePath, 'index' + ext);
    if (fs.existsSync(indexPath)) {
      return path.relative(config.rootDir, indexPath);
    }
  }

  return undefined;
}

// ============================================================================
// Import Finding
// ============================================================================

/**
 * Find all imports in a file
 */
function findImportsInFile(
  filePath: string,
  content: string,
  config: ImportRewriterConfig
): ImportLocation[] {
  const imports: ImportLocation[] = [];
  const fileDir = path.dirname(filePath);

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const visit = (node: ts.Node) => {
    // Handle import declarations
    if (ts.isImportDeclaration(node)) {
      const importLoc = parseImportDeclaration(node, sourceFile, filePath, fileDir, config);
      if (importLoc) {
        imports.push(importLoc);
      }
    }

    // Handle export declarations (re-exports)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const exportLoc = parseExportDeclaration(node, sourceFile, filePath, fileDir, config);
      if (exportLoc) {
        imports.push(exportLoc);
      }
    }

    // Handle dynamic imports
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const dynamicLoc = parseDynamicImport(node, sourceFile, filePath, fileDir, config);
      if (dynamicLoc) {
        imports.push(dynamicLoc);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}/**
 * Parse a standard import declaration
 */
function parseImportDeclaration(
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  fileDir: string,
  config: ImportRewriterConfig
): ImportLocation | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return null;
  }

  const source = node.moduleSpecifier.text;
  const resolvedPath = resolveImportPath(fileDir, source, config);

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  // Determine import style and extract symbols
  let style: ImportStyle;
  let kind: ImportKind = 'value';
  const symbols: ImportedSymbol[] = [];

  // Check for type-only imports
  if (node.importClause?.isTypeOnly) {
    kind = 'type';
  }

  if (!node.importClause) {
    // Side-effect import: import './module'
    style = 'side-effect';
  } else if (node.importClause.name && !node.importClause.namedBindings) {
    // Default import only: import foo from './module'
    style = 'default';
    symbols.push({
      name: 'default',
      alias: node.importClause.name.text,
      isTypeOnly: kind === 'type',
    });
  } else if (node.importClause.namedBindings) {
    if (ts.isNamespaceImport(node.importClause.namedBindings)) {
      // Namespace import: import * as foo from './module'
      style = 'namespace';
      symbols.push({
        name: '*',
        alias: node.importClause.namedBindings.name.text,
        isTypeOnly: kind === 'type',
      });
    } else if (ts.isNamedImports(node.importClause.namedBindings)) {
      // Named imports: import { foo, bar as baz } from './module'
      style = 'named';

      // Also handle combined default + named: import foo, { bar } from './module'
      if (node.importClause.name) {
        symbols.push({
          name: 'default',
          alias: node.importClause.name.text,
          isTypeOnly: kind === 'type',
        });
      }

      for (const element of node.importClause.namedBindings.elements) {
        const isElementTypeOnly = element.isTypeOnly || kind === 'type';
        symbols.push({
          name: element.propertyName?.text || element.name.text,
          alias: element.propertyName ? element.name.text : undefined,
          isTypeOnly: isElementTypeOnly,
        });
      }
    } else {
      style = 'named';
    }
  } else {
    style = 'named';
  }

  return {
    filePath,
    line: line + 1,
    column: character,
    endLine: endPos.line + 1,
    endColumn: endPos.character,
    startOffset: node.getStart(),
    endOffset: node.getEnd(),
    source,
    resolvedPath,
    style,
    kind,
    symbols,
    originalText: node.getText(sourceFile),
  };
}

/**
 * Parse an export declaration (re-export)
 */
function parseExportDeclaration(
  node: ts.ExportDeclaration,
  sourceFile: ts.SourceFile,
  filePath: string,
  fileDir: string,
  config: ImportRewriterConfig
): ImportLocation | null {
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
    return null;
  }

  const source = node.moduleSpecifier.text;
  const resolvedPath = resolveImportPath(fileDir, source, config);

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  let style: ImportStyle;
  let kind: ImportKind = 'value';
  const symbols: ImportedSymbol[] = [];

  // Check for type-only exports
  if (node.isTypeOnly) {
    kind = 'type';
  }

  if (!node.exportClause) {
    // Star export: export * from './module'
    style = 're-export-all';
    symbols.push({ name: '*', isTypeOnly: kind === 'type' });
  } else if (ts.isNamedExports(node.exportClause)) {
    // Named re-export: export { foo, bar as baz } from './module'
    style = 're-export';

    for (const element of node.exportClause.elements) {
      const isElementTypeOnly = element.isTypeOnly || kind === 'type';
      symbols.push({
        name: element.propertyName?.text || element.name.text,
        alias: element.propertyName ? element.name.text : undefined,
        isTypeOnly: isElementTypeOnly,
      });
    }
  } else {
    // Namespace re-export: export * as foo from './module'
    style = 're-export';
    if (ts.isNamespaceExport(node.exportClause)) {
      symbols.push({
        name: '*',
        alias: node.exportClause.name.text,
        isTypeOnly: kind === 'type',
      });
    }
  }

  return {
    filePath,
    line: line + 1,
    column: character,
    endLine: endPos.line + 1,
    endColumn: endPos.character,
    startOffset: node.getStart(),
    endOffset: node.getEnd(),
    source,
    resolvedPath,
    style,
    kind,
    symbols,
    originalText: node.getText(sourceFile),
  };
}

/**
 * Parse a dynamic import expression
 */
function parseDynamicImport(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  filePath: string,
  fileDir: string,
  config: ImportRewriterConfig
): ImportLocation | null {
  if (node.arguments.length === 0 || !ts.isStringLiteral(node.arguments[0])) {
    return null;
  }

  const arg = node.arguments[0] as ts.StringLiteral;
  const source = arg.text;
  const resolvedPath = resolveImportPath(fileDir, source, config);

  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    filePath,
    line: line + 1,
    column: character,
    endLine: endPos.line + 1,
    endColumn: endPos.character,
    startOffset: node.getStart(),
    endOffset: node.getEnd(),
    source,
    resolvedPath,
    style: 'dynamic',
    kind: 'value',
    symbols: [], // Dynamic imports don't have explicit symbols
    originalText: node.getText(sourceFile),
  };
}
/**
 * Apply import changes to a single file's content.
 * Handles multiple changes by sorting them in reverse order to preserve positions.
 */
function applyImportChangesToFile(
  content: string,
  changes: ImportChange[],
  config: ImportRewriterConfig
): string {
  // Convert changes to text edits
  const edits: TextEdit[] = [];

  for (const change of changes) {
    if (change.newSource === null) {
      // Remove the entire import
      edits.push({
        startOffset: change.location.startOffset,
        endOffset: change.location.endOffset,
        newText: '',
        description: `Remove import from '${change.oldSource}'`,
      });
    } else {
      // Rewrite the import path
      const newImportText = rewriteImportText(change, config);
      edits.push({
        startOffset: change.location.startOffset,
        endOffset: change.location.endOffset,
        newText: newImportText,
        description: `Rewrite import from '${change.oldSource}' to '${change.newSource}'`,
      });
    }
  }

  return applyTextEdits(content, edits);
}

/**
 * Generate new import text from a change
 */
function rewriteImportText(change: ImportChange, config: ImportRewriterConfig): string {
  const { location, newSource, symbolChanges } = change;

  // If no symbol changes, just replace the path
  if (!symbolChanges || symbolChanges.length === 0) {
    return location.originalText.replace(location.source, newSource!);
  }

  // Handle symbol changes (renaming, removing, etc.)
  const sourceFile = ts.createSourceFile(
    'temp.ts',
    location.originalText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let newText = location.originalText;

  // Find the import/export declaration
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      // Replace the module specifier
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        newText = newText.replace(
          `'${location.source}'`,
          `'${newSource}'`
        ).replace(
          `"${location.source}"`,
          `"${newSource}"`
        );
      }

      // Handle symbol changes in named imports/exports
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          const newSymbols = processSymbolChanges(
            node.importClause.namedBindings,
            symbolChanges,
            sourceFile
          );
          if (newSymbols !== null) {
            const oldBindings = node.importClause.namedBindings.getText(sourceFile);
            newText = newText.replace(oldBindings, newSymbols);
          }
        }
      }
    }
  });

  return newText;
}

/**
 * Process symbol changes for named imports
 */
function processSymbolChanges(
  namedBindings: ts.NamedImports,
  changes: Array<{ oldName: string; newName: string | null; newSource?: string }>,
  sourceFile: ts.SourceFile
): string | null {
  const changeMap = new Map(changes.map(c => [c.oldName, c]));
  const newElements: string[] = [];

  for (const element of namedBindings.elements) {
    const originalName = element.propertyName?.text || element.name.text;
    const localName = element.name.text;
    const change = changeMap.get(originalName);

    if (change) {
      if (change.newName === null) {
        // Remove this symbol from the import
        continue;
      }

      // Rename the symbol
      if (change.newName !== originalName) {
        if (localName !== originalName) {
          // Was already aliased: import { oldName as alias } -> import { newName as alias }
          newElements.push(`${change.newName} as ${localName}`);
        } else {
          // Not aliased: import { oldName } -> import { newName }
          newElements.push(change.newName);
        }
      } else {
        // Keep as-is
        newElements.push(element.getText(sourceFile));
      }
    } else {
      // No change for this symbol
      newElements.push(element.getText(sourceFile));
    }
  }

  if (newElements.length === 0) {
    return null; // All symbols removed
  }

  return `{ ${newElements.join(', ')} }`;
}

/**
 * Find all files that import from any of the given source files
 */
export async function findFilesImporting(
  sourceFiles: string[],
  config: ImportRewriterConfig
): Promise<Map<string, ImportLocation[]>> {
  const allFiles = await findSourceFiles(config.rootDir, config.ignore);
  const result = new Map<string, ImportLocation[]>();

  // Normalize source files to absolute paths
  const absoluteSources = sourceFiles.map(f =>
    path.isAbsolute(f) ? f : path.resolve(config.rootDir, f)
  );
  const normalizedSources = absoluteSources.map(normalizeFilePath);

  for (const file of allFiles) {
    // Skip the source files themselves
    if (normalizedSources.includes(normalizeFilePath(file))) {
      continue;
    }

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = findImportsInFile(file, content, config);

      // Filter to imports of any source file
      const matchingImports = imports.filter(imp => {
        if (!imp.resolvedPath) return false;
        const normalizedResolved = normalizeFilePath(
          path.isAbsolute(imp.resolvedPath)
            ? imp.resolvedPath
            : path.resolve(config.rootDir, imp.resolvedPath)
        );
        return normalizedSources.includes(normalizedResolved);
      });

      if (matchingImports.length > 0) {
        result.set(file, matchingImports);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return result;
}
/** Legacy import location type for backward compatibility */
interface LegacyImportLocation {
  /** Start position in the source */
  start: number;
  /** End position in the source */
  end: number;
  /** The full module specifier text (e.g., './utils') */
  moduleSpecifier: string;
  /** Line number */
  line: number;
}

// ============================================================================
// Batch Move Support
// ============================================================================

/** A file move mapping */
export interface FileMove {
  /** Original file path (relative to root) */
  from: string;
  /** New file path (relative to root) */
  to: string;
}

/**
 * Find all import updates needed for a batch of file moves
 * Returns a map of file -> list of import changes needed
 */
export async function findImportUpdatesForMoves(
  moves: FileMove[],
  config: ImportRewriterConfig
): Promise<Map<string, ImportChange[]>> {
  const result = new Map<string, ImportChange[]>();

  // Build a mapping of old paths to new paths
  const moveMap = new Map<string, string>();
  for (const move of moves) {
    const normalizedFrom = normalizeFilePath(
      path.isAbsolute(move.from) ? move.from : path.resolve(config.rootDir, move.from)
    );
    moveMap.set(normalizedFrom, move.to);
  }

  // Find all source files that might have imports to update
  const allFiles = await findSourceFiles(config.rootDir, config.ignore);

  // Get paths that are being moved (we need to update their internal imports too)
  const movedFilePaths = new Set(moves.map(m =>
    path.isAbsolute(m.from) ? m.from : path.resolve(config.rootDir, m.from)
  ));

  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const imports = findImportsInFile(file, content, config);
      const changes: ImportChange[] = [];

      // Determine the effective path of this file (if it's being moved, use new location)
      const normalizedFile = normalizeFilePath(file);
      let effectiveFilePath = file;

      // Check if this file is being moved
      for (const move of moves) {
        const normalizedFrom = normalizeFilePath(
          path.isAbsolute(move.from) ? move.from : path.resolve(config.rootDir, move.from)
        );
        if (normalizedFile === normalizedFrom) {
          effectiveFilePath = path.resolve(config.rootDir, move.to);
          break;
        }
      }

      for (const imp of imports) {
        if (!imp.resolvedPath) continue;

        // Check if this import points to a file that's being moved
        const normalizedResolved = normalizeFilePath(
          path.isAbsolute(imp.resolvedPath)
            ? imp.resolvedPath
            : path.resolve(config.rootDir, imp.resolvedPath)
        );

        const newTargetPath = moveMap.get(normalizedResolved);
        if (newTargetPath) {
          // Calculate new relative import path
          const newSource = calculateRelativeImport(
            effectiveFilePath,
            path.resolve(config.rootDir, newTargetPath)
          );

          changes.push({
            filePath: file,
            oldSource: imp.source,
            newSource,
            location: imp,
          });
        } else if (movedFilePaths.has(file)) {
          // This file is being moved, recalculate relative path to unchanged target
          const targetAbsolute = path.isAbsolute(imp.resolvedPath)
            ? imp.resolvedPath
            : path.resolve(config.rootDir, imp.resolvedPath);

          const newSource = calculateRelativeImport(effectiveFilePath, targetAbsolute);

          // Only add if the path actually changes
          if (newSource !== imp.source) {
            changes.push({
              filePath: file,
              oldSource: imp.source,
              newSource,
              location: imp,
            });
          }
        }
      }

      if (changes.length > 0) {
        result.set(file, changes);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return result;
}

/**
 * Apply batch file moves with import updates
 * This is the main function for reorganization operations
 */
export async function applyBatchMoves(
  moves: FileMove[],
  config: ImportRewriterConfig,
  options: { dryRun?: boolean } = {}
): Promise<{
  success: boolean;
  movedFiles: Array<{ from: string; to: string }>;
  updatedImports: Map<string, string>; // file -> new content
  errors: string[];
}> {
  const errors: string[] = [];
  const movedFiles: Array<{ from: string; to: string }> = [];
  const updatedImports = new Map<string, string>();

  // Step 0: Validate all moves before doing anything
  const validMoves: FileMove[] = [];
  const movingFrom = new Set<string>(); // Track files being moved away

  for (const move of moves) {
    const fromPath = path.isAbsolute(move.from)
      ? move.from
      : path.resolve(config.rootDir, move.from);
    const toPath = path.isAbsolute(move.to)
      ? move.to
      : path.resolve(config.rootDir, move.to);

    // Skip no-op moves
    if (fromPath === toPath) {
      continue;
    }

    // Check source exists
    if (!fs.existsSync(fromPath)) {
      errors.push(`Source file does not exist: ${move.from}`);
      continue;
    }

    movingFrom.add(fromPath);
    validMoves.push(move);
  }

  // Check for destination conflicts (file exists and not being moved away)
  for (const move of validMoves) {
    const toPath = path.isAbsolute(move.to)
      ? move.to
      : path.resolve(config.rootDir, move.to);

    if (fs.existsSync(toPath) && !movingFrom.has(toPath)) {
      errors.push(`Destination already exists and would be overwritten: ${move.to}`);
    }
  }

  // If validation failed, abort early
  if (errors.length > 0) {
    return {
      success: false,
      movedFiles,
      updatedImports,
      errors,
    };
  }

  try {
    // Step 1: Find all import updates needed
    const importUpdates = await findImportUpdatesForMoves(validMoves, config);

    // Step 2: Apply import changes to file contents
    for (const [file, changes] of importUpdates) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const newContent = applyImportChangesToFile(content, changes, config);
        updatedImports.set(file, newContent);

        if (!options.dryRun) {
          fs.writeFileSync(file, newContent, 'utf-8');
        }
      } catch (err) {
        errors.push(`Failed to update imports in ${file}: ${err}`);
      }
    }

    // Step 3: Create destination directories and move files
    if (!options.dryRun) {
      for (const move of validMoves) {
        try {
          const fromPath = path.isAbsolute(move.from)
            ? move.from
            : path.resolve(config.rootDir, move.from);
          const toPath = path.isAbsolute(move.to)
            ? move.to
            : path.resolve(config.rootDir, move.to);

          // Create destination directory
          const destDir = path.dirname(toPath);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }

          // Read the file content (may have been updated)
          let content: string;
          if (updatedImports.has(fromPath)) {
            content = updatedImports.get(fromPath)!;
          } else {
            content = fs.readFileSync(fromPath, 'utf-8');
          }

          // Write to new location
          fs.writeFileSync(toPath, content, 'utf-8');

          // Delete original
          fs.unlinkSync(fromPath);

          movedFiles.push({ from: move.from, to: move.to });
        } catch (err) {
          errors.push(`Failed to move ${move.from} to ${move.to}: ${err}`);
        }
      }
    } else {
      // In dry-run mode, just record what would be moved
      for (const move of validMoves) {
        movedFiles.push({ from: move.from, to: move.to });
      }
    }

    return {
      success: errors.length === 0,
      movedFiles,
      updatedImports,
      errors,
    };
  } catch (err) {
    errors.push(`Batch move failed: ${err}`);
    return {
      success: false,
      movedFiles,
      updatedImports,
      errors,
    };
  }
}