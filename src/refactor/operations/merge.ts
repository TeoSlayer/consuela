/**
 * Merge operation - combines multiple files into one
 *
 * This operation:
 * 1. Reads all source files
 * 2. Combines their exports (detecting conflicts)
 * 3. Creates the target file with combined code
 * 4. Rewrites imports across the codebase
 * 5. Deletes original files (unless dryRun)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { FileChange, ExportConflict, MergeOptions } from '../types.js';
import {
  findFilesImporting,
  calculateRelativeImport,
} from '../import-rewriter.js';
import { parseSourceFile, detectExportConflicts, getExportKey,  hasExportModifier,  getScriptKind } from './sourceAnalysis.js';

export interface MergeResult {
  /** Whether the merge succeeded */
  success: boolean;
  /** Path to the merged target file */
  targetFile: string;
  /** Files that were merged */
  mergedFrom: string[];
  /** Number of import statements rewritten */
  importsRewritten: number;
  /** Files that were deleted */
  filesDeleted: string[];
  /** Export conflicts detected (same name exported from multiple files) */
  conflicts?: ExportConflict[];
  /** Errors encountered during merge */
  errors?: string[];
  /** Detailed file changes (for preview) */
  changes?: FileChange[];
  /** Files where imports were updated */
  filesUpdated?: string[];
}

interface ParsedExport {
  name: string;
  kind: string;
  isDefault: boolean;
  code: string;
  line: number;
  sourceFile: string;
  dependencies: string[];
}

interface SourceFileInfo {
  filePath: string;
  relativePath: string;
  content: string;
  exports: ParsedExport[];
  imports: string[];
  localDeclarations: Set<string>;
}

/**
 * Merge multiple files into a single target file
 */
export async function mergeFiles(options: MergeOptions): Promise<MergeResult> {
  const rootDir = options.rootDir || process.cwd();
  const deleteOriginals = options.deleteOriginals !== false;
  const dryRun = options.dryRun || false;

  const result: MergeResult = {
    success: false,
    targetFile: '',
    mergedFrom: [],
    importsRewritten: 0,
    filesDeleted: [],
    changes: [],
    filesUpdated: [],
  };

  const errors: string[] = [];

  try {
    // Normalize all paths
    const absoluteSources = options.sources.map(s =>
      path.isAbsolute(s) ? s : path.resolve(rootDir, s)
    );
    const absoluteTarget = path.isAbsolute(options.target)
      ? options.target
      : path.resolve(rootDir, options.target);

    result.targetFile = path.relative(rootDir, absoluteTarget);
    result.mergedFrom = absoluteSources.map(s => path.relative(rootDir, s));

    // Validate source files exist
    for (const source of absoluteSources) {
      if (!fs.existsSync(source)) {
        errors.push(`Source file not found: ${source}`);
      }
    }

    if (errors.length > 0) {
      result.errors = errors;
      return result;
    }

    // Parse all source files
    const sourceInfos: SourceFileInfo[] = [];
    for (const source of absoluteSources) {
      const info = parseSourceFile(source, rootDir);
      sourceInfos.push(info);
    }

    // Detect export conflicts
    const conflicts = detectExportConflicts(sourceInfos);
    if (conflicts.length > 0) {
      result.conflicts = conflicts;
      // Don't fail on conflicts, but warn about them
      for (const conflict of conflicts) {
        errors.push(
          `Export conflict: "${conflict.name}" is exported from multiple files: ${conflict.sources.join(', ')}`
        );
      }
    }

    // Generate merged content
    const mergedContent = generateMergedContent(sourceInfos, absoluteTarget, rootDir);

    // Record target file change
    const existingTargetContent = fs.existsSync(absoluteTarget)
      ? fs.readFileSync(absoluteTarget, 'utf-8')
      : '';

    result.changes!.push({
      filePath: path.relative(rootDir, absoluteTarget),
      changeType: existingTargetContent ? 'modify' : 'create',
      originalContent: existingTargetContent,
      newContent: mergedContent,
      description: `Create merged file from: ${result.mergedFrom.join(', ')}`,
    });

    // Find all files that import from the source files
    const importingFiles = await findFilesImporting(absoluteSources, {
      rootDir,
      dryRun,
    });

    // Rewrite imports in each file
    for (const [filePath, imports] of importingFiles) {
      // Skip the target file and source files
      if (filePath === absoluteTarget || absoluteSources.includes(filePath)) {
        continue;
      }

      const originalContent = fs.readFileSync(filePath, 'utf-8');
      const newImportPath = calculateRelativeImport(filePath, absoluteTarget);

      // Remove the .js extension we added and let the import rewriter handle it
      const cleanNewImportPath = newImportPath.replace(/\.js$/, '.js');

      // Use regex to find and replace import sources in the original content
      let newContent = originalContent;
      for (const imp of imports) {
        // Replace the import source in the original text
        const originalText = imp.originalText;
        const newText = originalText.replace(
          new RegExp(`(['"])${escapeRegex(imp.source)}\\1`),
          `$1${cleanNewImportPath}$1`
        );
        newContent = newContent.replace(originalText, newText);
      }

      if (newContent !== originalContent) {
        result.changes!.push({
          filePath: path.relative(rootDir, filePath),
          changeType: 'modify',
          originalContent,
          newContent,
          description: `Update imports to point to ${result.targetFile}`,
        });
        result.importsRewritten += imports.length;
        result.filesUpdated!.push(path.relative(rootDir, filePath));
      }
    }

    // Apply changes if not dry run
    if (!dryRun) {
      // Ensure target directory exists
      const targetDir = path.dirname(absoluteTarget);
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }

      // Write merged file
      fs.writeFileSync(absoluteTarget, mergedContent, 'utf-8');

      // Update import files
      for (const change of result.changes!) {
        if (change.filePath !== result.targetFile && change.newContent) {
          const fullPath = path.resolve(rootDir, change.filePath);
          fs.writeFileSync(fullPath, change.newContent, 'utf-8');
        }
      }

      // Delete original files
      if (deleteOriginals) {
        for (const source of absoluteSources) {
          // Don't delete if the source is the same as target
          if (source !== absoluteTarget) {
            fs.unlinkSync(source);
            result.filesDeleted.push(path.relative(rootDir, source));
          }
        }
      }
    } else {
      // In dry run, report what would be deleted
      if (deleteOriginals) {
        for (const source of absoluteSources) {
          if (source !== absoluteTarget) {
            result.filesDeleted.push(path.relative(rootDir, source));
          }
        }
      }
    }

    result.success = errors.length === 0 || errors.every(e => e.startsWith('Export conflict'));
    if (errors.length > 0) {
      result.errors = errors;
    }

    return result;
  } catch (error) {
    result.errors = [
      ...errors,
      error instanceof Error ? error.message : String(error),
    ];
    return result;
  }
}

/**
 * Generate the merged file content
 */
function generateMergedContent(
  sourceInfos: SourceFileInfo[],
  targetPath: string,
  rootDir: string
): string {
  const lines: string[] = [];
  const seenImports = new Set<string>();
  const seenExports = new Set<string>();
  const allExportedNames = new Set<string>();

  // Header comment
  lines.push('/**');
  lines.push(' * Merged file');
  lines.push(` * Combined from: ${sourceInfos.map(s => s.relativePath).join(', ')}`);
  lines.push(' */');
  lines.push('');

  // Collect all unique imports (excluding imports from files being merged)
  const mergedFilePaths = new Set(sourceInfos.map(s => s.filePath));
  const allImports: string[] = [];

  for (const info of sourceInfos) {
    for (const imp of info.imports) {
      // Skip imports from files being merged
      if (imp.startsWith('.')) {
        const resolvedImport = path.resolve(path.dirname(info.filePath), imp);
        const normalizedResolved = resolvedImport.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

        let isInternalImport = false;
        for (const mergedPath of mergedFilePaths) {
          const normalizedMerged = mergedPath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
          if (normalizedResolved === normalizedMerged ||
              normalizedResolved === normalizedMerged + '/index') {
            isInternalImport = true;
            break;
          }
        }

        if (isInternalImport) continue;
      }

      if (!seenImports.has(imp)) {
        seenImports.add(imp);
        allImports.push(imp);
      }
    }
  }

  // We need to reconstruct actual import statements from the source files
  // For now, we'll extract the full import lines
  const importLines: string[] = [];

  for (const info of sourceInfos) {
    const sourceFile = ts.createSourceFile(
      info.filePath,
      info.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(info.filePath)
    );

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const importSource = node.moduleSpecifier.text;

        // Check if this import is from a merged file
        if (importSource.startsWith('.')) {
          const resolvedImport = path.resolve(path.dirname(info.filePath), importSource);
          const normalizedResolved = resolvedImport.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

          for (const mergedPath of mergedFilePaths) {
            const normalizedMerged = mergedPath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
            if (normalizedResolved === normalizedMerged ||
                normalizedResolved === normalizedMerged + '/index') {
              return; // Skip this import
            }
          }
        }

        // Adjust relative import paths for the new target location
        let finalImportSource = importSource;
        if (importSource.startsWith('.')) {
          const absoluteImportPath = path.resolve(path.dirname(info.filePath), importSource);
          finalImportSource = calculateRelativeImport(targetPath, absoluteImportPath + '.ts')
            .replace(/\.ts\.js$/, '.js');
        }

        // Reconstruct the import statement
        const importText = node.getText(sourceFile);
        const adjustedImport = importText.replace(
          new RegExp(`['"]${escapeRegex(importSource)}['"]`),
          `'${finalImportSource}'`
        );

        if (!importLines.includes(adjustedImport)) {
          importLines.push(adjustedImport);
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  // Add imports
  if (importLines.length > 0) {
    lines.push(...importLines);
    lines.push('');
  }

  // Add exports from each file
  for (const info of sourceInfos) {
    const sourceFile = ts.createSourceFile(
      info.filePath,
      info.content,
      ts.ScriptTarget.Latest,
      true,
      getScriptKind(info.filePath)
    );

    // Add a section comment
    lines.push(`// --- From ${info.relativePath} ---`);
    lines.push('');

    // Extract and add each exported declaration
    const visit = (node: ts.Node) => {
      // Skip imports (already handled)
      if (ts.isImportDeclaration(node)) {
        return;
      }

      // Handle export declarations (re-exports)
      if (ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const exportSource = node.moduleSpecifier.text;

          // Skip re-exports from merged files
          if (exportSource.startsWith('.')) {
            const resolvedExport = path.resolve(path.dirname(info.filePath), exportSource);
            const normalizedResolved = resolvedExport.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

            for (const mergedPath of mergedFilePaths) {
              const normalizedMerged = mergedPath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
              if (normalizedResolved === normalizedMerged ||
                  normalizedResolved === normalizedMerged + '/index') {
                return; // Skip this re-export
              }
            }
          }

          // Adjust the re-export path
          let finalExportSource = exportSource;
          if (exportSource.startsWith('.')) {
            const absoluteExportPath = path.resolve(path.dirname(info.filePath), exportSource);
            finalExportSource = calculateRelativeImport(targetPath, absoluteExportPath + '.ts')
              .replace(/\.ts\.js$/, '.js');
          }

          const exportText = node.getText(sourceFile);
          const adjustedExport = exportText.replace(
            new RegExp(`['"]${escapeRegex(exportSource)}['"]`),
            `'${finalExportSource}'`
          );

          if (!seenExports.has(adjustedExport)) {
            seenExports.add(adjustedExport);
            lines.push(adjustedExport);
            lines.push('');
          }
        }
        return;
      }

      // Handle exported declarations
      if (hasExportModifier(node)) {
        const code = node.getText(sourceFile);
        const key = getExportKey(node, sourceFile);

        if (key && !allExportedNames.has(key)) {
          allExportedNames.add(key);
          lines.push(code);
          lines.push('');
        } else if (key && allExportedNames.has(key)) {
          // Conflict - comment out the duplicate
          lines.push(`// CONFLICT: ${key} already exported from another merged file`);
          lines.push(`// ${code.split('\n').join('\n// ')}`);
          lines.push('');
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
