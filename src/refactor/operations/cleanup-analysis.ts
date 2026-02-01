import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ProjectAnalysis, ExportInfo } from '../../core/index.js';
import { ConsolidatedDuplicate } from '../types.js';

/** Re-export information */
interface ReExportInfo {
  barrelFile: string;
  exportedName: string;
  originalFile: string;
}

/**
 * Resolve an import path to a relative file path
 */
export function resolveImportPath(
  fromFile: string,
  importPath: string,
  rootDir: string
): string | undefined {
  if (!importPath.startsWith('.')) {
    return undefined; // Not a relative import
  }

  const fromDir = path.dirname(fromFile);
  let resolved = path.normalize(path.join(fromDir, importPath));

  // Remove .js/.ts extensions and try to resolve
  resolved = resolved.replace(/\.(js|ts|jsx|tsx|mjs)$/, '');

  const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
  for (const ext of extensions) {
    if (fs.existsSync(path.join(rootDir, resolved + ext))) {
      return resolved + ext;
    }
  }

  // Try index files
  for (const ext of extensions) {
    const indexPath = path.join(resolved, 'index' + ext);
    if (fs.existsSync(path.join(rootDir, indexPath))) {
      return indexPath;
    }
  }

  return undefined;
}

/**
 * Find duplicate functions across the codebase
 */
export function findDuplicateFunctions(analysis: ProjectAnalysis): ConsolidatedDuplicate[] {
  const duplicates: ConsolidatedDuplicate[] = [];
  const signatureMap = new Map<string, ExportInfo[]>();

  // Group exports by signature
  for (const [, exports] of analysis.exports) {
    for (const exp of exports) {
      if (exp.signature && (exp.kind === 'function' || exp.kind === 'const')) {
        const key = `${exp.name}:${exp.signature}`;
        const existing = signatureMap.get(key) || [];
        existing.push(exp);
        signatureMap.set(key, existing);
      }
    }
  }

  // Find groups with duplicates
  for (const [, exports] of signatureMap) {
    if (exports.length > 1) {
      // Sort by file path to determine which to keep
      exports.sort((a, b) => a.filePath.localeCompare(b.filePath));

      const kept = exports[0];
      const removed = exports.slice(1);

      duplicates.push({
        kept: `${kept.filePath}:${kept.name}`,
        removed: removed.map(e => `${e.filePath}:${e.name}`),
        name: kept.name,
      });
    }
  }

  return duplicates;
}

/**
 * Check if a symbol is used internally within the same file
 * This prevents removing types/interfaces/classes that are used by other exports in the same file
 */
export function isUsedInternally(symbolName: string, symbolKind: string, fileContent: string): boolean {
  // Skip checking for very short names that would have many false positives
  if (symbolName.length < 2) return true;

  // For types/interfaces, check if they're used as type annotations
  if (symbolKind === 'type' || symbolKind === 'interface') {
    // Look for usage patterns:
    // : TypeName (type annotation)
    // <TypeName> (generic parameter)
    // extends TypeName (inheritance)
    // implements TypeName (implementation)
    // TypeName[] (array type)
    // TypeName | (union type)
    // & TypeName (intersection type)
    const typeUsagePatterns = [
      new RegExp(`:\\s*${symbolName}\\b`, 'g'),           // : TypeName
      new RegExp(`:\\s*${symbolName}\\[`, 'g'),           // : TypeName[]
      new RegExp(`<${symbolName}\\b`, 'g'),               // <TypeName
      new RegExp(`extends\\s+${symbolName}\\b`, 'g'),     // extends TypeName
      new RegExp(`implements\\s+${symbolName}\\b`, 'g'),  // implements TypeName
      new RegExp(`\\|\\s*${symbolName}\\b`, 'g'),         // | TypeName
      new RegExp(`${symbolName}\\s*\\|`, 'g'),            // TypeName |
      new RegExp(`&\\s*${symbolName}\\b`, 'g'),           // & TypeName
      new RegExp(`${symbolName}\\s*&`, 'g'),              // TypeName &
      new RegExp(`Promise<${symbolName}`, 'g'),           // Promise<TypeName>
      new RegExp(`Array<${symbolName}`, 'g'),             // Array<TypeName>
      new RegExp(`Map<[^>]*${symbolName}`, 'g'),          // Map<..., TypeName>
      new RegExp(`Set<${symbolName}`, 'g'),               // Set<TypeName>
    ];

    let usageCount = 0;
    for (const pattern of typeUsagePatterns) {
      const matches = fileContent.match(pattern);
      if (matches) {
        usageCount += matches.length;
      }
    }

    // If there's more than one usage (the declaration itself), it's used internally
    // For types/interfaces, the declaration itself counts as one
    return usageCount > 0;
  }

  // For classes, check if they're instantiated or extended
  if (symbolKind === 'class') {
    const classUsagePatterns = [
      new RegExp(`new\\s+${symbolName}\\s*\\(`, 'g'),     // new ClassName(
      new RegExp(`extends\\s+${symbolName}\\b`, 'g'),     // extends ClassName
      new RegExp(`:\\s*${symbolName}\\b`, 'g'),           // : ClassName (type annotation)
    ];

    for (const pattern of classUsagePatterns) {
      if (pattern.test(fileContent)) {
        return true;
      }
    }
    return false;
  }

  // For functions/variables, check if they're called/referenced
  if (symbolKind === 'function' || symbolKind === 'variable' || symbolKind === 'const') {
    // Count occurrences of the symbol name as a word
    const wordPattern = new RegExp(`\\b${symbolName}\\b`, 'g');
    const matches = fileContent.match(wordPattern);

    // If there's more than one occurrence (the declaration), it's used internally
    return matches !== null && matches.length > 1;
  }

  // For enums, check if enum members are used
  if (symbolKind === 'enum') {
    const enumUsagePattern = new RegExp(`${symbolName}\\.\\w+`, 'g');
    if (enumUsagePattern.test(fileContent)) {
      return true;
    }
  }

  // Default: don't remove if we're unsure
  return false;
}

/**
 * Get all source files in the project
 */
export function getAllSourceFiles(rootDir: string): string[] {
  const files: string[] = [];
  const ignoreDirs = ['node_modules', 'dist', 'build', '.git', 'coverage'];

  function walk(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignoreDirs.includes(entry.name)) {
            walk(fullPath);
          }
        } else if (entry.isFile()) {
          if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  walk(rootDir);
  return files;
}

/**
 * Get TypeScript script kind from file path
 */
export function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Find all barrel/index files in the project
 * Barrel files re-export from other modules
 */
export function findBarrelFiles(rootDir: string): string[] {
  const barrelFiles: string[] = [];
  const allFiles = getAllSourceFiles(rootDir);

  for (const filePath of allFiles) {
    const fileName = path.basename(filePath);

    // Index files are likely barrels
    if (fileName.startsWith('index.')) {
      barrelFiles.push(path.relative(rootDir, filePath));
      continue;
    }

    // Check if file has mostly re-exports
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Count export statements
      const exportFromMatches = content.match(/export\s+(\{[^}]+\}|\*)\s+from/g);
      const totalLines = content.split('\n').filter(l => l.trim()).length;

      // If more than 50% of non-empty lines are re-exports, it's a barrel
      if (exportFromMatches && exportFromMatches.length > 0) {
        const exportLines = exportFromMatches.length;
        if (exportLines / totalLines > 0.3) {
          barrelFiles.push(path.relative(rootDir, filePath));
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return barrelFiles;
}

/**
 * Find all re-exports in the project
 * Maps exported symbols to their original source files
 */
export function findReExports(rootDir: string, barrelFiles: string[]): Map<string, ReExportInfo[]> {
  const reExports = new Map<string, ReExportInfo[]>();

  for (const barrelFile of barrelFiles) {
    const absolutePath = path.join(rootDir, barrelFile);
    if (!fs.existsSync(absolutePath)) continue;

    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      const sourceFile = ts.createSourceFile(
        absolutePath,
        content,
        ts.ScriptTarget.Latest,
        true,
        getScriptKind(absolutePath)
      );

      // Find all export declarations
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const importPath = node.moduleSpecifier.text;
          const resolvedPath = resolveImportPath(barrelFile, importPath, rootDir);

          if (resolvedPath) {
            // Handle named exports: export { foo, bar } from './file'
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
              for (const element of node.exportClause.elements) {
                const exportedName = element.name.text;
                const originalName = element.propertyName?.text || exportedName;

                // Create a key that combines file and symbol
                const key = `${resolvedPath}:${originalName}`;
                const existing = reExports.get(key) || [];
                existing.push({
                  barrelFile,
                  exportedName,
                  originalFile: resolvedPath,
                });
                reExports.set(key, existing);
              }
            }
            // Handle star exports: export * from './file'
            else if (!node.exportClause) {
              // Star export - we need to mark all exports from that file as re-exported
              // For now, just mark the file itself
              const key = `${resolvedPath}:*`;
              const existing = reExports.get(key) || [];
              existing.push({
                barrelFile,
                exportedName: '*',
                originalFile: resolvedPath,
              });
              reExports.set(key, existing);
            }
          }
        }
      });
    } catch {
      // Skip files that fail to parse
    }
  }

  return reExports;
}
