/**
 * Cleanup operation - Remove dead code from the codebase
 *
 * Features:
 * - Remove unused exports (functions, classes, variables, types)
 * - Remove empty files after cleanup
 * - Consolidate duplicate functions (stretch goal)
 *
 * Safety:
 * - Never removes entry points (package.json main/exports/bin)
 * - Preserves file formatting
 * - Shows clear diff of what's being removed
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createConfiguredAnalyzer,
  type ProjectAnalysis,
  type UnusedExport,
  type ExportInfo,
} from '../../core/index.js';
import type { RemovedExport, ConsolidatedDuplicate } from '../types.js';
import { resolveImportPath, findDuplicateFunctions, isUsedInternally, getAllSourceFiles, getScriptKind, findBarrelFiles, findReExports } from './cleanup-analysis.js';
import { cleanup } from './cleanup-core.js';
export { cleanup } from './cleanup-core.js';

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

export interface CleanupOptions {
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

export interface CleanupResult {
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
 * Check if a symbol is directly imported by any file in the project
 * This catches cases where the unused export detection misses direct imports
 */
function isDirectlyImported(
  symbolName: string,
  exportFilePath: string,
  _analysis: ProjectAnalysis,
  rootDir: string
): boolean {
  // Get the base name of the export file (without extension)
  const exportFileBase = path.basename(exportFilePath).replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

  // Scan all TypeScript/JavaScript files in the project
  const allFiles = getAllSourceFiles(rootDir);

  for (const filePath of allFiles) {
    // Skip the export file itself
    const relativePath = path.relative(rootDir, filePath);
    if (relativePath === exportFilePath) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Look for import statements that:
      // 1. Import from the export file (relative path matching)
      // 2. Include the symbol name

      // Pattern: import { symbolName } from './path/to/exportFile'
      // or: import { something, symbolName, other } from './path'
      // Handles both .js and no extension imports
      const importPattern = new RegExp(
        `import\\s+(?:type\\s+)?\\{[^}]*\\b${escapeRegexForImport(symbolName)}\\b[^}]*\\}\\s+from\\s+['"][^'"]*${escapeRegexForImport(exportFileBase)}(?:\\.js)?['"]`,
        'g'
      );

      if (importPattern.test(content)) {
        return true;
      }

      // Also check for namespace imports that might use the symbol
      // import * as foo from './file' ... foo.symbolName
      const namespacePattern = new RegExp(
        `import\\s+\\*\\s+as\\s+(\\w+)\\s+from\\s+['"][^'"]*${escapeRegexForImport(exportFileBase)}(?:\\.js)?['"]`
      );
      const nsMatch = content.match(namespacePattern);
      if (nsMatch) {
        const nsName = nsMatch[1];
        const usagePattern = new RegExp(`\\b${nsName}\\.${escapeRegexForImport(symbolName)}\\b`);
        if (usagePattern.test(content)) {
          return true;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return false;
}

function escapeRegexForImport(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generate a human-readable diff preview
 */
export function generateDiffPreview(fileChange: FileChange): string {
  const lines: string[] = [];
  const originalLines = fileChange.originalContent.split('\n');
  const newLines = fileChange.newContent.split('\n');

  lines.push(`--- ${fileChange.filePath}`);
  lines.push(`+++ ${fileChange.filePath}`);
  lines.push('');

  // Simple line-by-line diff
  const maxLines = Math.max(originalLines.length, newLines.length);
  let contextBefore = 0;
  let inChange = false;

  for (let i = 0; i < maxLines; i++) {
    const origLine = originalLines[i];
    const newLine = newLines[i];

    if (origLine !== newLine) {
      // Show context before change
      if (!inChange && contextBefore < 3) {
        const contextStart = Math.max(0, i - 3);
        for (let j = contextStart; j < i; j++) {
          lines.push(`  ${originalLines[j]}`);
        }
      }
      inChange = true;
      contextBefore = 0;

      if (origLine !== undefined && newLine === undefined) {
        lines.push(`- ${origLine}`);
      } else if (origLine === undefined && newLine !== undefined) {
        lines.push(`+ ${newLine}`);
      } else {
        lines.push(`- ${origLine}`);
        lines.push(`+ ${newLine}`);
      }
    } else if (inChange) {
      contextBefore++;
      if (contextBefore <= 3) {
        lines.push(`  ${origLine}`);
      } else {
        inChange = false;
        lines.push('...');
      }
    }
  }

  return lines.join('\n');
}