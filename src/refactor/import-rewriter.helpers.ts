import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { TextEdit } from './types.js';

/**
 * Apply text edits to content, handling overlapping edits by applying in reverse order
 */
export function applyTextEdits(content: string, edits: TextEdit[]): string {
  // Sort by startOffset descending
  const sortedEdits = [...edits].sort((a, b) => b.startOffset - a.startOffset);

  let result = content;
  for (const edit of sortedEdits) {
    result = result.slice(0, edit.startOffset) + edit.newText + result.slice(edit.endOffset);
  }

  // Clean up any resulting empty lines from removed imports
  result = result.replace(/^\s*\n(?=\s*\n)/gm, '');

  return result;
}
/**
 * Try to resolve a path with various extensions
 */
export function tryResolveWithExtensions(basePath: string, extensions: string[]): string | undefined {
  // Check exact path
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return basePath;
  }

  // Strip .js/.mjs extension if present (ESM imports use .js but files are .ts)
  const baseWithoutExt = basePath.replace(/\.(js|mjs)$/, '');

  // Try extensions on stripped path
  for (const ext of extensions) {
    const fullPath = baseWithoutExt + ext;
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Also try original path + extensions (for cases without .js)
  if (baseWithoutExt !== basePath) {
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

/**
 * Normalize a file path for comparison (removes extension, handles case)
 */
export function normalizeFilePath(filePath: string): string {
  return filePath
    .replace(/\.(ts|tsx|js|jsx|mjs)$/, '')
    .replace(/[/\\]index$/, '')
    .toLowerCase();
}

// ============================================================================
// Utilities
// ============================================================================
/**
 * Get TypeScript ScriptKind from file extension
 */
export function getScriptKind(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath);
  switch (ext) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

/**
 * Calculate the relative import path from one file to another
 * @deprecated Use computeNewImportPath instead
 */
export function calculateRelativeImport(fromFile: string, toFile: string): string {
  const fromDir = path.dirname(fromFile);
  let relativePath = path.relative(fromDir, toFile);

  relativePath = relativePath.replace(/\\/g, '/');
  relativePath = relativePath.replace(/\.(ts|tsx|js|jsx|mjs)$/, '');

  if (!relativePath.startsWith('.') && !relativePath.startsWith('/')) {
    relativePath = './' + relativePath;
  }

  relativePath = relativePath + '.js';

  return relativePath;
}
