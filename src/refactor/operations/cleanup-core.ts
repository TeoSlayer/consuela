import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createConfiguredAnalyzer, ProjectAnalysis, UnusedExport } from '../../core/index.js';
import type { RemovedExport, ConsolidatedDuplicate } from '../types.js';
import { resolveImportPath, findDuplicateFunctions, isUsedInternally, getScriptKind, findBarrelFiles, findReExports } from './cleanup-analysis.js';

/** Re-export information */
interface ReExportInfo {
  barrelFile: string;
  exportedName: string;
  originalFile: string;
}

/** File change for cleanup operations */
interface FileChange {
  filePath: string;
  originalContent: string;
  newContent: string;
  removedExports: string[];
  removedImports: string[];
}

interface CleanupOptions {
  /** Remove unused exports */
  removeUnused?: boolean;
  /** Consolidate duplicate functions */
  removeDuplicates?: boolean;
  /** Delete files with no exports after cleanup */
  removeEmptyFiles?: boolean;
  /** Show what would be done without making changes */
  dryRun?: boolean;
  /** Root directory to analyze */
  rootDir?: string;
}

interface CleanupResult {
  success: boolean;
  removedExports: RemovedExport[];
  removedFiles: string[];
  consolidatedDuplicates: ConsolidatedDuplicate[];
  errors: string[];
  /** Changes by file for preview */
  fileChanges: Map<string, FileChange>;
}

interface ExportLocation {
  start: number;
  end: number;
  name: string;
  kind: string;
  includesLeadingComments: boolean;
}

/**
 * Main cleanup function - analyzes and removes dead code
 */
export async function cleanup(options: CleanupOptions): Promise<CleanupResult> {
  const rootDir = options.rootDir || process.cwd();
  const result: CleanupResult = {
    success: true,
    removedExports: [],
    removedFiles: [],
    consolidatedDuplicates: [],
    errors: [],
    fileChanges: new Map(),
  };

  try {
    // Step 1: Analyze the codebase
    const analyzer = createConfiguredAnalyzer(rootDir);
    const analysis = await analyzer.analyze();

    // Step 2: Find unused exports (excluding entry points and re-exported)
    if (options.removeUnused) {
      // Find barrel files and re-exports first
      const barrelFiles = findBarrelFiles(rootDir);
      const reExports = findReExports(rootDir, barrelFiles);

      const unused = analyzer.findUnusedExports(analysis);

      // Split into two categories:
      // 1. toRemove - exports not used internally (delete entire declaration)
      // 2. toUnexport - exports used internally (just remove export keyword)
      const toRemove: UnusedExport[] = [];
      const toUnexport: UnusedExport[] = [];

      for (const u of unused) {
        // Skip entry points
        if (u.reason.includes('Entry point')) continue;

        // Check if this export is re-exported by a barrel/index file
        const reExportInfo = isReExported(u.export.name, u.export.filePath, reExports);
        if (reExportInfo) {
          // This export is re-exported by a barrel file - don't touch it
          continue;
        }

        // Check if the export is used internally within the same file
        const absolutePath = path.join(rootDir, u.export.filePath);
        if (fs.existsSync(absolutePath)) {
          const content = fs.readFileSync(absolutePath, 'utf-8');
          if (isUsedInternally(u.export.name, u.export.kind, content)) {
            // Used internally - just remove export keyword, keep the declaration
            toUnexport.push(u);
            continue;
          }
        }

        // Not used anywhere - remove entire declaration
        toRemove.push(u);
      }

      // Group by file for efficient processing
      const byFile = groupByFile(toRemove);
      const byFileUnexport = groupByFile(toUnexport);

      // Step 3: Process each file
      for (const [filePath, exports] of byFile) {
        const absolutePath = path.join(rootDir, filePath);

        if (!fs.existsSync(absolutePath)) {
          result.errors.push(`File not found: ${filePath}`);
          continue;
        }

        try {
          const fileChange = await removeExportsFromFile(
            absolutePath,
            filePath,
            exports,
            analysis
          );

          if (fileChange) {
            result.fileChanges.set(filePath, fileChange);

            for (const exp of exports) {
              result.removedExports.push({
                file: filePath,
                name: exp.export.name,
                kind: exp.export.kind,
                line: exp.export.line,
                reason: exp.reason,
              });
            }
          }
        } catch (error) {
          result.errors.push(`Error processing ${filePath}: ${error}`);
        }
      }

      // Step 3b: Process files that need export keyword removed (but keep declaration)
      for (const [filePath, exports] of byFileUnexport) {
        const absolutePath = path.join(rootDir, filePath);

        if (!fs.existsSync(absolutePath)) {
          continue;
        }

        try {
          const fileChange = await removeExportKeywordsFromFile(
            absolutePath,
            filePath,
            exports
          );

          if (fileChange) {
            // Merge with existing changes if any
            const existing = result.fileChanges.get(filePath);
            if (existing) {
              // Apply our changes to the already-modified content
              existing.newContent = fileChange.newContent;
              existing.removedExports.push(...fileChange.removedExports);
            } else {
              result.fileChanges.set(filePath, fileChange);
            }

            for (const exp of exports) {
              result.removedExports.push({
                file: filePath,
                name: exp.export.name,
                kind: exp.export.kind,
                line: exp.export.line,
                reason: `${exp.reason} (made private, still used internally)`,
              });
            }
          }
        } catch (error) {
          result.errors.push(`Error unexporting from ${filePath}: ${error}`);
        }
      }
    }

    // Step 4: Find and consolidate duplicates
    if (options.removeDuplicates) {
      const duplicates = findDuplicateFunctions(analysis);
      for (const dup of duplicates) {
        result.consolidatedDuplicates.push(dup);
        // TODO: Implement actual consolidation
        // This would require updating imports across the codebase
      }
    }

    // Step 5: Remove empty files
    if (options.removeEmptyFiles) {
      for (const [filePath, change] of result.fileChanges) {
        if (isFileEmpty(change.newContent)) {
          result.removedFiles.push(filePath);
        }
      }
    }

    // Step 6: Apply changes (unless dry run)
    if (!options.dryRun) {
      // First, remove imports of the removed exports from other files
      for (const removed of result.removedExports) {
        await removeImportsOfSymbol(rootDir, removed.name, removed.file, analysis);
      }

      // Then apply the file changes
      for (const [filePath, change] of result.fileChanges) {
        const absolutePath = path.join(rootDir, filePath);

        if (result.removedFiles.includes(filePath)) {
          // Delete the file
          fs.unlinkSync(absolutePath);

          // Remove imports to this file from other files
          await removeImportsToFile(rootDir, filePath, analysis);
        } else {
          // Write the updated content
          fs.writeFileSync(absolutePath, change.newContent, 'utf-8');
        }
      }
    }

  } catch (error) {
    result.success = false;
    result.errors.push(`Analysis failed: ${error}`);
  }

  return result;
}

/**
 * Group unused exports by file path
 */
function groupByFile(unused: UnusedExport[]): Map<string, UnusedExport[]> {
  const byFile = new Map<string, UnusedExport[]>();

  for (const u of unused) {
    const existing = byFile.get(u.export.filePath) || [];
    existing.push(u);
    byFile.set(u.export.filePath, existing);
  }

  return byFile;
}

/**
 * Remove specified exports from a file
 */
async function removeExportsFromFile(
  absolutePath: string,
  relativePath: string,
  exportsToRemove: UnusedExport[],
  analysis: ProjectAnalysis
): Promise<FileChange | null> {
  const originalContent = fs.readFileSync(absolutePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    originalContent,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(absolutePath)
  );

  // Find the locations of all exports to remove
  const exportNames = new Set(exportsToRemove.map(e => e.export.name));
  const locationsToRemove: ExportLocation[] = [];

  const visit = (node: ts.Node) => {
    const location = getExportLocation(node, sourceFile, exportNames);
    if (location) {
      locationsToRemove.push(location);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (locationsToRemove.length === 0) {
    return null;
  }

  // Sort by position (descending) to remove from end to start
  locationsToRemove.sort((a, b) => b.start - a.start);

  // Remove the exports
  let newContent = originalContent;
  const removedExports: string[] = [];
  const removedImports: string[] = [];

  for (const loc of locationsToRemove) {
    // Include leading whitespace/newlines in the removal
    let start = loc.start;
    while (start > 0 && (newContent[start - 1] === ' ' || newContent[start - 1] === '\t')) {
      start--;
    }
    // Remove the preceding newline if this is a standalone statement
    if (start > 0 && newContent[start - 1] === '\n') {
      start--;
      if (start > 0 && newContent[start - 1] === '\r') {
        start--;
      }
    }

    // Include trailing newline in the removal
    let end = loc.end;
    while (end < newContent.length && (newContent[end] === ' ' || newContent[end] === '\t')) {
      end++;
    }
    if (end < newContent.length && newContent[end] === '\r') {
      end++;
    }
    if (end < newContent.length && newContent[end] === '\n') {
      end++;
    }

    newContent = newContent.slice(0, start) + newContent.slice(end);
    removedExports.push(loc.name);
  }

  // Clean up any resulting double blank lines
  newContent = newContent.replace(/\n\n\n+/g, '\n\n');

  // Ensure proper spacing between declarations after removal
  // Fix cases where closing brace ends up directly touching comments or declarations
  newContent = newContent.replace(/\}(\/\*\*)/g, '}\n\n$1');
  newContent = newContent.replace(/\}(\/\/)/g, '}\n\n$1');
  newContent = newContent.replace(/\}(export\s)/g, '}\n\n$1');
  newContent = newContent.replace(/\}(import\s)/g, '}\n\n$1');

  // Check for now-unused imports after removing exports
  const unusedImports = findUnusedImportsAfterRemoval(
    newContent,
    absolutePath,
    removedExports
  );

  if (unusedImports.length > 0) {
    newContent = removeUnusedImports(newContent, absolutePath, unusedImports);
    removedImports.push(...unusedImports);
  }

  return {
    filePath: relativePath,
    originalContent,
    newContent,
    removedExports,
    removedImports,
  };
}

/**
 * Remove export keywords from declarations (make them private)
 * Used for exports that aren't imported elsewhere but are used internally
 */
async function removeExportKeywordsFromFile(
  absolutePath: string,
  relativePath: string,
  exportsToUnexport: UnusedExport[]
): Promise<FileChange | null> {
  const originalContent = fs.readFileSync(absolutePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    originalContent,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(absolutePath)
  );

  const exportNames = new Set(exportsToUnexport.map(e => e.export.name));
  const removals: { start: number; end: number; name: string }[] = [];

  const visit = (node: ts.Node) => {
    // Check for export modifier on declarations
    if (!ts.canHaveModifiers(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const modifiers = ts.getModifiers(node);
    const exportModifier = modifiers?.find(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exportModifier) {
      ts.forEachChild(node, visit);
      return;
    }

    let name: string | undefined;

    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isVariableStatement(node)) {
      const declarations = node.declarationList.declarations;
      for (const decl of declarations) {
        if (ts.isIdentifier(decl.name) && exportNames.has(decl.name.text)) {
          name = decl.name.text;
          break;
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node)) {
      name = node.name.text;
    } else if (ts.isEnumDeclaration(node)) {
      name = node.name.text;
    }

    if (name && exportNames.has(name)) {
      // Find the export keyword and any trailing space
      let start = exportModifier.getStart(sourceFile);
      let end = exportModifier.getEnd();

      // Include trailing whitespace
      const text = originalContent.slice(end);
      const spaceMatch = text.match(/^\s+/);
      if (spaceMatch) {
        end += spaceMatch[0].length;
      }

      removals.push({ start, end, name });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  if (removals.length === 0) {
    return null;
  }

  // Sort by position (descending) to remove from end to start
  removals.sort((a, b) => b.start - a.start);

  let newContent = originalContent;
  const removedExports: string[] = [];

  for (const { start, end, name } of removals) {
    newContent = newContent.slice(0, start) + newContent.slice(end);
    removedExports.push(name);
  }

  return {
    filePath: relativePath,
    originalContent,
    newContent,
    removedExports,
    removedImports: [],
  };
}

/**
 * Get the location of an export node if it matches the names to remove
 */
function getExportLocation(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  exportNames: Set<string>
): ExportLocation | null {
  // Handle export declarations: export { foo, bar as baz } or export { foo } from './file'
  if (ts.isExportDeclaration(node)) {
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      // Check if any of the exported names match
      for (const element of node.exportClause.elements) {
        const exportedName = element.name.text;
        if (exportNames.has(exportedName)) {
          // If this is the only export in the declaration, remove the whole thing
          if (node.exportClause.elements.length === 1) {
            return {
              start: node.getFullStart(),
              end: node.getEnd(),
              name: exportedName,
              kind: 'unknown',
              includesLeadingComments: false,
            };
          }
          // Multiple exports - we'd need to handle removing just one specifier
          // For now, return the whole declaration if we're removing all of them
          const allMatch = node.exportClause.elements.every(e => exportNames.has(e.name.text));
          if (allMatch) {
            return {
              start: node.getFullStart(),
              end: node.getEnd(),
              name: exportedName,
              kind: 'unknown',
              includesLeadingComments: false,
            };
          }
        }
      }
    }
    return null;
  }

  // Handle default export: export default foo
  if (ts.isExportAssignment(node)) {
    if (exportNames.has('default')) {
      return {
        start: node.getFullStart(),
        end: node.getEnd(),
        name: 'default',
        kind: 'unknown',
        includesLeadingComments: false,
      };
    }
    return null;
  }

  // Check for export modifier on declarations
  const hasExportModifier = ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);

  if (!hasExportModifier) {
    return null;
  }

  let name: string | undefined;
  let kind: string = 'unknown';

  if (ts.isFunctionDeclaration(node) && node.name) {
    name = node.name.text;
    kind = 'function';
  } else if (ts.isClassDeclaration(node) && node.name) {
    name = node.name.text;
    kind = 'class';
  } else if (ts.isVariableStatement(node)) {
    const declarations = node.declarationList.declarations;
    for (const decl of declarations) {
      if (ts.isIdentifier(decl.name) && exportNames.has(decl.name.text)) {
        if (declarations.length === 1) {
          name = decl.name.text;
          kind = (node.declarationList.flags & ts.NodeFlags.Const) !== 0 ? 'const' : 'variable';
        }
      }
    }
  } else if (ts.isInterfaceDeclaration(node)) {
    name = node.name.text;
    kind = 'interface';
  } else if (ts.isTypeAliasDeclaration(node)) {
    name = node.name.text;
    kind = 'type';
  } else if (ts.isEnumDeclaration(node)) {
    name = node.name.text;
    kind = 'enum';
  }

  if (name && exportNames.has(name)) {
    const fullStart = node.getFullStart();
    const start = node.getStart(sourceFile);
    const end = node.getEnd();
    const leadingComments = ts.getLeadingCommentRanges(sourceFile.text, fullStart);
    const includesLeadingComments = leadingComments && leadingComments.length > 0;

    return {
      start: includesLeadingComments ? fullStart : start,
      end,
      name,
      kind,
      includesLeadingComments: !!includesLeadingComments,
    };
  }

  return null;
}

/**
 * Find imports that are no longer used after removing exports
 */
function findUnusedImportsAfterRemoval(
  content: string,
  filePath: string,
  removedExports: string[]
): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const unusedImports: string[] = [];
  const importedNames = new Map<string, { count: number; isTypeOnly: boolean }>();

  // First, collect all imported names
  const collectImports = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const isTypeOnly = node.importClause.isTypeOnly;

      if (node.importClause.name) {
        const name = node.importClause.name.text;
        importedNames.set(name, { count: 0, isTypeOnly });
      }

      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            const name = element.name.text;
            importedNames.set(name, { count: 0, isTypeOnly: isTypeOnly || element.isTypeOnly });
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          const name = node.importClause.namedBindings.name.text;
          importedNames.set(name, { count: 0, isTypeOnly });
        }
      }
    }
    ts.forEachChild(node, collectImports);
  };

  // Then, count usages of each imported name
  const countUsages = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (importedNames.has(name)) {
        // Skip if this is in an import declaration
        let parent: ts.Node | undefined = node.parent;
        while (parent) {
          if (ts.isImportDeclaration(parent) || ts.isImportSpecifier(parent)) {
            return;
          }
          parent = parent.parent;
        }

        const info = importedNames.get(name)!;
        info.count++;
      }
    }
    ts.forEachChild(node, countUsages);
  };

  collectImports(sourceFile);
  countUsages(sourceFile);

  // Find imports with zero usages
  for (const [name, info] of importedNames) {
    if (info.count === 0) {
      unusedImports.push(name);
    }
  }

  return unusedImports;
}

/**
 * Remove unused imports from file content
 */
function removeUnusedImports(
  content: string,
  filePath: string,
  unusedImports: string[]
): string {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const unusedSet = new Set(unusedImports);
  const removals: { start: number; end: number }[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && node.importClause) {
      let shouldRemoveEntireImport = true;
      const namedImportsToRemove: ts.ImportSpecifier[] = [];

      // Check default import
      if (node.importClause.name) {
        if (!unusedSet.has(node.importClause.name.text)) {
          shouldRemoveEntireImport = false;
        }
      }

      // Check named imports
      if (node.importClause.namedBindings) {
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const element of node.importClause.namedBindings.elements) {
            if (unusedSet.has(element.name.text)) {
              namedImportsToRemove.push(element);
            } else {
              shouldRemoveEntireImport = false;
            }
          }
        } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
          if (!unusedSet.has(node.importClause.namedBindings.name.text)) {
            shouldRemoveEntireImport = false;
          }
        }
      }

      if (shouldRemoveEntireImport) {
        // Remove the entire import statement
        removals.push({
          start: node.getFullStart(),
          end: node.getEnd(),
        });
      } else if (namedImportsToRemove.length > 0) {
        // Remove only specific named imports
        for (const specifier of namedImportsToRemove) {
          let start = specifier.getStart(sourceFile);
          let end = specifier.getEnd();

          // Handle trailing comma
          const text = content.slice(end);
          const commaMatch = text.match(/^\s*,/);
          if (commaMatch) {
            end += commaMatch[0].length;
          } else {
            // Handle leading comma
            const beforeText = content.slice(0, start);
            const leadingCommaMatch = beforeText.match(/,\s*$/);
            if (leadingCommaMatch) {
              start -= leadingCommaMatch[0].length;
            }
          }

          removals.push({ start, end });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  // Sort by position (descending) and apply removals
  removals.sort((a, b) => b.start - a.start);

  let newContent = content;
  for (const { start, end } of removals) {
    newContent = newContent.slice(0, start) + newContent.slice(end);
  }

  // Clean up empty lines
  newContent = newContent.replace(/\n\n\n+/g, '\n\n');

  return newContent;
}

/**
 * Check if a file is effectively empty (no meaningful exports)
 */
function isFileEmpty(content: string): boolean {
  // Remove comments and whitespace
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')  // Block comments
    .replace(/\/\/.*$/gm, '')           // Line comments
    .replace(/^\s*[\r\n]/gm, '')        // Empty lines
    .trim();

  // Check if there are any export statements left
  const hasExports = /\bexport\b/.test(stripped);

  // Check if there's any meaningful code
  const hasCode = stripped.length > 0 && !/^\s*$/.test(stripped);

  return !hasExports && !hasCode;
}

/**
 * Remove imports to a deleted file from all other files
 */
async function removeImportsToFile(
  rootDir: string,
  deletedFilePath: string,
  analysis: ProjectAnalysis
): Promise<void> {
  // Find all files that import from the deleted file
  const importers = analysis.reverseGraph.get(deletedFilePath);
  if (!importers) return;

  for (const importerPath of importers) {
    const absolutePath = path.join(rootDir, importerPath);
    if (!fs.existsSync(absolutePath)) continue;

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      absolutePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(absolutePath)
    );

    const removals: { start: number; end: number }[] = [];

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const importPath = node.moduleSpecifier.text;

        // Check if this import points to the deleted file
        const resolvedPath = resolveImportPath(importerPath, importPath, rootDir);
        if (resolvedPath === deletedFilePath) {
          removals.push({
            start: node.getFullStart(),
            end: node.getEnd(),
          });
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (removals.length > 0) {
      removals.sort((a, b) => b.start - a.start);

      let newContent = content;
      for (const { start, end } of removals) {
        newContent = newContent.slice(0, start) + newContent.slice(end);
      }

      newContent = newContent.replace(/\n\n\n+/g, '\n\n');
      fs.writeFileSync(absolutePath, newContent, 'utf-8');
    }
  }
}

/**
 * Remove imports of a specific symbol from all files that import it
 * This is called when we remove an export - we need to update importers
 */
async function removeImportsOfSymbol(
  rootDir: string,
  symbolName: string,
  sourceFilePath: string,
  analysis: ProjectAnalysis
): Promise<void> {
  // Find all files that import from the source file
  const importers = analysis.reverseGraph.get(sourceFilePath);
  if (!importers) return;

  for (const importerPath of importers) {
    const absolutePath = path.join(rootDir, importerPath);
    if (!fs.existsSync(absolutePath)) continue;

    const content = fs.readFileSync(absolutePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      absolutePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(absolutePath)
    );

    const removals: { start: number; end: number }[] = [];
    let needsRewrite = false;

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const importPath = node.moduleSpecifier.text;
        const resolvedPath = resolveImportPath(importerPath, importPath, rootDir);

        if (resolvedPath !== sourceFilePath) return;

        if (!node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) {
          return;
        }

        const namedImports = node.importClause.namedBindings;
        const elements = namedImports.elements;

        // Find the element that imports our symbol
        let symbolElement: ts.ImportSpecifier | undefined;
        for (const element of elements) {
          const importedName = element.propertyName?.text || element.name.text;
          if (importedName === symbolName) {
            symbolElement = element;
            break;
          }
        }

        if (!symbolElement) return;

        // If this is the only import, remove the entire import declaration
        if (elements.length === 1) {
          removals.push({
            start: node.getFullStart(),
            end: node.getEnd(),
          });
          needsRewrite = true;
        } else {
          // Remove just this specifier from the named imports
          let start = symbolElement.getStart(sourceFile);
          let end = symbolElement.getEnd();

          // Handle trailing comma
          const text = content.slice(end);
          const commaMatch = text.match(/^\s*,/);
          if (commaMatch) {
            end += commaMatch[0].length;
          } else {
            // Handle leading comma
            const beforeText = content.slice(0, start);
            const leadingCommaMatch = beforeText.match(/,\s*$/);
            if (leadingCommaMatch) {
              start -= leadingCommaMatch[0].length;
            }
          }

          removals.push({ start, end });
          needsRewrite = true;
        }
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    if (needsRewrite && removals.length > 0) {
      removals.sort((a, b) => b.start - a.start);

      let newContent = content;
      for (const { start, end } of removals) {
        newContent = newContent.slice(0, start) + newContent.slice(end);
      }

      newContent = newContent.replace(/\n\n\n+/g, '\n\n');
      fs.writeFileSync(absolutePath, newContent, 'utf-8');
    }
  }
}

/**
 * Check if a symbol is re-exported by another file (barrel/index)
 */
function isReExported(
  symbolName: string,
  filePath: string,
  reExports: Map<string, ReExportInfo[]>
): ReExportInfo | null {
  // Check for direct re-export
  const directKey = `${filePath}:${symbolName}`;
  const directReExport = reExports.get(directKey);
  if (directReExport && directReExport.length > 0) {
    return directReExport[0];
  }

  // Check for star re-export
  const starKey = `${filePath}:*`;
  const starReExport = reExports.get(starKey);
  if (starReExport && starReExport.length > 0) {
    return starReExport[0];
  }

  return null;
}
