import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { ExportConflict } from '../types.js';

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
 * Parse a source file and extract its exports and structure
 */
export function parseSourceFile(filePath: string, rootDir: string): SourceFileInfo {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = path.relative(rootDir, filePath);

  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const exports: ParsedExport[] = [];
  const imports: string[] = [];
  const localDeclarations = new Set<string>();

  // Track what's being imported so we can handle re-exports
  const importedSymbols = new Map<string, string>(); // localName -> source

  const visit = (node: ts.Node) => {
    // Collect imports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);

      // Track imported names
      if (node.importClause) {
        if (node.importClause.name) {
          importedSymbols.set(node.importClause.name.text, node.moduleSpecifier.text);
        }
        if (node.importClause.namedBindings) {
          if (ts.isNamedImports(node.importClause.namedBindings)) {
            for (const element of node.importClause.namedBindings.elements) {
              importedSymbols.set(element.name.text, node.moduleSpecifier.text);
            }
          } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
            importedSymbols.set(node.importClause.namedBindings.name.text, node.moduleSpecifier.text);
          }
        }
      }
    }

    // Collect export declarations (re-exports)
    if (ts.isExportDeclaration(node)) {
      const exportCode = node.getText(sourceFile);
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          exports.push({
            name: element.name.text,
            kind: 'unknown',
            isDefault: false,
            code: exportCode,
            line,
            sourceFile: relativePath,
            dependencies: [],
          });
        }
      } else if (!node.exportClause && node.moduleSpecifier) {
        // export * from './module'
        exports.push({
          name: '*',
          kind: 'reexport',
          isDefault: false,
          code: exportCode,
          line,
          sourceFile: relativePath,
          dependencies: [],
        });
      }
    }

    // Collect export assignments (default exports)
    if (ts.isExportAssignment(node)) {
      exports.push({
        name: 'default',
        kind: 'unknown',
        isDefault: true,
        code: node.getText(sourceFile),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        sourceFile: relativePath,
        dependencies: [],
      });
    }

    // Collect exported declarations
    if (hasExportModifier(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const isDefault = hasDefaultModifier(node);
      const code = node.getText(sourceFile);

      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = isDefault ? 'default' : node.name.text;
        localDeclarations.add(node.name.text);
        exports.push({
          name,
          kind: 'function',
          isDefault,
          code,
          line,
          sourceFile: relativePath,
          dependencies: extractDependencies(node, sourceFile),
        });
      } else if (ts.isClassDeclaration(node) && node.name) {
        const name = isDefault ? 'default' : node.name.text;
        localDeclarations.add(node.name.text);
        exports.push({
          name,
          kind: 'class',
          isDefault,
          code,
          line,
          sourceFile: relativePath,
          dependencies: extractDependencies(node, sourceFile),
        });
      } else if (ts.isVariableStatement(node)) {
        const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            localDeclarations.add(decl.name.text);
            exports.push({
              name: decl.name.text,
              kind: isConst ? 'constant' : 'variable',
              isDefault: false,
              code,
              line,
              sourceFile: relativePath,
              dependencies: extractDependencies(node, sourceFile),
            });
          }
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        localDeclarations.add(node.name.text);
        exports.push({
          name: node.name.text,
          kind: 'interface',
          isDefault: false,
          code,
          line,
          sourceFile: relativePath,
          dependencies: [],
        });
      } else if (ts.isTypeAliasDeclaration(node)) {
        localDeclarations.add(node.name.text);
        exports.push({
          name: node.name.text,
          kind: 'type',
          isDefault: false,
          code,
          line,
          sourceFile: relativePath,
          dependencies: [],
        });
      } else if (ts.isEnumDeclaration(node)) {
        localDeclarations.add(node.name.text);
        exports.push({
          name: node.name.text,
          kind: 'enum',
          isDefault: false,
          code,
          line,
          sourceFile: relativePath,
          dependencies: [],
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    filePath,
    relativePath,
    content,
    exports,
    imports,
    localDeclarations,
  };
}

/**
 * Detect export conflicts (same name exported from multiple files)
 */
export function detectExportConflicts(sourceInfos: SourceFileInfo[]): ExportConflict[] {
  const exportMap = new Map<string, Array<{ source: string; kind: string }>>();

  for (const info of sourceInfos) {
    for (const exp of info.exports) {
      if (exp.name === '*') continue; // Skip star exports

      const existing = exportMap.get(exp.name) || [];
      existing.push({ source: info.relativePath, kind: exp.kind });
      exportMap.set(exp.name, existing);
    }
  }

  const conflicts: ExportConflict[] = [];
  for (const [name, sources] of exportMap) {
    if (sources.length > 1) {
      conflicts.push({
        name,
        sources: sources.map(s => s.source),
        kind: sources[0].kind,
      });
    }
  }

  return conflicts;
}

/**
 * Get a unique key for an export to detect duplicates
 */
export function getExportKey(node: ts.Node, _sourceFile: ts.SourceFile): string | null {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isVariableStatement(node)) {
    const names: string[] = [];
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name)) {
        names.push(decl.name.text);
      }
    }
    return names.join(',');
  }
  if (ts.isInterfaceDeclaration(node)) {
    return node.name.text;
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return node.name.text;
  }
  if (ts.isEnumDeclaration(node)) {
    return node.name.text;
  }
  return null;
}

/**
 * Extract dependencies (referenced identifiers) from a node
 */
function extractDependencies(node: ts.Node, _sourceFile: ts.SourceFile): string[] {
  const deps: string[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      deps.push(n.text);
    }
    ts.forEachChild(n, visit);
  };

  ts.forEachChild(node, visit);
  return [...new Set(deps)];
}

export function hasExportModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

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
