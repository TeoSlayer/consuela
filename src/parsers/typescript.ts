import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  LanguageParser,
  FileParseResult,
  Export,
  Import,
  Usage,
  LocalSymbol,
  ResolverConfig,
} from './types.js';

/**
 * TypeScript/JavaScript language parser
 */
export class TypeScriptParser implements LanguageParser {
  readonly id = 'typescript';
  readonly name = 'TypeScript/JavaScript';
  readonly extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

  // --- Public API Methods ---

  parseFile(filePath: string, content: string): FileParseResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      this.getScriptKind(filePath)
    );

    const exports: Export[] = [];
    const imports: Import[] = [];
    const localSymbols = new Map<string, LocalSymbol>();

    const traverse = (node: ts.Node) => {
      // Handle various export syntaxes
      if (ts.isExportDeclaration(node)) {
        this.handleExportDeclaration(node, sourceFile, filePath, exports);
      } else if (ts.isExportAssignment(node)) {
        this.handleExportAssignment(node, sourceFile, filePath, exports);
      } else if (this.hasExportModifier(node)) {
        this.handleExportedDeclaration(node, sourceFile, filePath, exports);
      }

      // Handle import declarations
      if (ts.isImportDeclaration(node)) {
        this.handleImportDeclaration(node, sourceFile, filePath, imports, localSymbols);
      }

      ts.forEachChild(node, traverse);
    };

    traverse(sourceFile);

    return { filePath, exports, imports, localSymbols };
  }

  resolveImport(
    importSource: string,
    fromFile: string,
    config: ResolverConfig
  ): string | undefined {
    // Handle TypeScript ESM: imports often use .js/.mjs extensions even if the source is .ts
    const normalizedPath = importSource.replace(/\.(js|mjs|jsx)$/, '');

    const extensions = config.extensions || [
      '.ts', '.tsx', '.js', '.jsx', '.mjs',
      '/index.ts', '/index.tsx', '/index.js', '/index.jsx'
    ];

    // 1. Handle relative imports
    if (normalizedPath.startsWith('.')) {
      const fromDir = path.dirname(path.join(config.rootDir, fromFile));
      const resolvedBase = path.resolve(fromDir, normalizedPath);
      return this.tryResolveWithExtensions(resolvedBase, extensions, config.rootDir);
    }

    // 2. Handle path aliases from tsconfig (e.g., @app/*)
    if (config.pathAliases) {
      for (const [aliasPrefix, targetPaths] of config.pathAliases) {
        if (normalizedPath.startsWith(aliasPrefix)) {
          const remainder = normalizedPath.slice(aliasPrefix.length);
          for (const targetPath of targetPaths) {
            const resolvedBase = path.join(targetPath, remainder);
            const result = this.tryResolveWithExtensions(resolvedBase, extensions, config.rootDir);
            if (result) return result;
          }
        }
      }
    }

    // 3. Handle baseUrl imports
    if (config.baseUrl) {
      const resolvedBase = path.join(config.baseUrl, normalizedPath);
      const result = this.tryResolveWithExtensions(resolvedBase, extensions, config.rootDir);
      if (result) return result;
    }

    // External module or unresolvable
    return undefined;
  }

  findUsages(
    filePath: string,
    content: string,
    symbolName: string,
    _localSymbols: Map<string, LocalSymbol>
  ): Usage[] {
    const usages: Usage[] = [];
    const sourceLines = content.split('\n');
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      this.getScriptKind(filePath)
    );

    const traverse = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        // We only care about references, not the original declaration or import lines
        const isRef = !this.isDeclaration(node) && !this.isInImportDeclaration(node);

        if (isRef) {
          const lineNum = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
          usages.push({
            filePath,
            line: lineNum + 1,
            context: sourceLines[lineNum]?.trim() || '',
            type: this.getUsageType(node),
          });
        }
      }

      ts.forEachChild(node, traverse);
    };

    traverse(sourceFile);
    return usages;
  }

  getTidyPrompt(): string {
    return `You are refactoring TypeScript/JavaScript code. Focus on:
- Modern ES6+ patterns
- Proper type annotations
- Async/await over callbacks
- Destructuring where appropriate
- Const over let where possible`;
  }

  // --- Private Parsing Helpers ---

  private getScriptKind(filePath: string): ts.ScriptKind {
    const ext = path.extname(filePath);
    switch (ext) {
      case '.tsx': return ts.ScriptKind.TSX;
      case '.jsx': return ts.ScriptKind.JSX;
      case '.js':
      case '.mjs': return ts.ScriptKind.JS;
      default: return ts.ScriptKind.TS;
    }
  }

  private getLine(node: ts.Node, sourceFile: ts.SourceFile): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  private hasExportModifier(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  private isDefaultExport(node: ts.Node): boolean {
    if (!ts.canHaveModifiers(node)) return false;
    return ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
  }

  private handleExportDeclaration(
    node: ts.ExportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    exports: Export[]
  ) {
    const line = this.getLine(node, sourceFile);

    // Case: "export * from './module'"
    if (!node.exportClause && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      exports.push({
        name: '*',
        kind: 'unknown',
        filePath,
        line,
        isDefault: false,
        isReExport: true,
        originalSource: node.moduleSpecifier.text,
      });
      return;
    }

    // Case: "export { a, b as c } [from './module']"
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      const source = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;

      for (const element of node.exportClause.elements) {
        exports.push({
          name: element.name.text,
          kind: 'unknown',
          filePath,
          line,
          isDefault: false,
          isReExport: !!source,
          originalSource: source,
        });
      }
    }
  }

  private handleExportAssignment(
    node: ts.ExportAssignment,
    sourceFile: ts.SourceFile,
    filePath: string,
    exports: Export[]
  ) {
    exports.push({
      name: 'default',
      kind: 'unknown',
      filePath,
      line: this.getLine(node, sourceFile),
      isDefault: true,
    });
  }

  private handleExportedDeclaration(
    node: ts.Node,
    sourceFile: ts.SourceFile,
    filePath: string,
    exports: Export[]
  ) {
    const line = this.getLine(node, sourceFile);
    const isDefault = this.isDefaultExport(node);

    if (ts.isFunctionDeclaration(node) && node.name) {
      exports.push({
        name: isDefault ? 'default' : node.name.text,
        kind: 'function',
        filePath,
        line,
        isDefault,
        signature: this.getFunctionSignature(node, sourceFile),
      });
    } else if (ts.isClassDeclaration(node) && node.name) {
      exports.push({
        name: isDefault ? 'default' : node.name.text,
        kind: 'class',
        filePath,
        line,
        isDefault,
        signature: this.getClassSignature(node, sourceFile),
      });
    } else if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          exports.push({
            name: decl.name.text,
            kind: isConst ? 'constant' : 'variable',
            filePath,
            line,
            isDefault: false,
            signature: decl.type?.getText(sourceFile),
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      exports.push({
        name: node.name.text,
        kind: 'interface',
        filePath,
        line,
        isDefault: false,
        signature: this.getInterfaceSignature(node, sourceFile),
      });
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.push({
        name: node.name.text,
        kind: 'type',
        filePath,
        line,
        isDefault: false,
        signature: node.type.getText(sourceFile).slice(0, 100),
      });
    } else if (ts.isEnumDeclaration(node)) {
      exports.push({
        name: node.name.text,
        kind: 'enum',
        filePath,
        line,
        isDefault: false,
      });
    }
  }

  private handleImportDeclaration(
    node: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    imports: Import[],
    localSymbols: Map<string, LocalSymbol>
  ) {
    const moduleSpecifier = node.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) return;

    const source = moduleSpecifier.text;
    const line = this.getLine(node, sourceFile);

    if (node.importClause) {
      // Default import: import Name from 'source'
      if (node.importClause.name) {
        const localName = node.importClause.name.text;
        imports.push({ name: 'default', alias: localName, source, filePath, line, isDefault: true });
        localSymbols.set(localName, { source, originalName: 'default' });
      }

      const bindings = node.importClause.namedBindings;
      if (bindings) {
        if (ts.isNamedImports(bindings)) {
          // Named imports: import { a as b } from 'source'
          for (const element of bindings.elements) {
            const originalName = element.propertyName?.text || element.name.text;
            const localName = element.name.text;
            imports.push({
              name: originalName,
              alias: element.propertyName ? localName : undefined,
              source,
              filePath,
              line,
              isDefault: false,
            });
            localSymbols.set(localName, { source, originalName });
          }
        } else if (ts.isNamespaceImport(bindings)) {
          // Namespace import: import * as Name from 'source'
          const localName = bindings.name.text;
          imports.push({ name: '*', alias: localName, source, filePath, line, isDefault: false });
          localSymbols.set(localName, { source, originalName: '*' });
        }
      }
    }
  }

  // --- Signature Generation Helpers ---

  private getFunctionSignature(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string {
    const params = node.parameters.map((p) => {
      const name = p.name.getText(sourceFile);
      const type = p.type ? `: ${p.type.getText(sourceFile)}` : '';
      const optional = p.questionToken ? '?' : '';
      return `${name}${optional}${type}`;
    }).join(', ');
    const returnType = node.type ? `: ${node.type.getText(sourceFile)}` : '';
    return `(${params})${returnType}`;
  }

  private getClassSignature(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): string {
    const members: string[] = [];
    for (const member of node.members) {
      const modifiers = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
      const isPrivate = modifiers?.some(
        (m: ts.Modifier) => m.kind === ts.SyntaxKind.PrivateKeyword || m.kind === ts.SyntaxKind.ProtectedKeyword
      );
      if (isPrivate || !member.name) continue;

      const name = member.name.getText(sourceFile);
      if (ts.isMethodDeclaration(member)) {
        members.push(`${name}()`);
      } else if (ts.isPropertyDeclaration(member)) {
        members.push(name);
      }
    }
    return this.formatSignatureObject(members);
  }

  private getInterfaceSignature(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string {
    const members = node.members.map((m) => {
      if (!m.name) return '';
      const name = m.name.getText(sourceFile);
      return ts.isMethodSignature(m) ? `${name}()` : name;
    }).filter(Boolean);
    return this.formatSignatureObject(members);
  }

  private formatSignatureObject(members: string[]): string {
    const MAX_MEMBERS = 5;
    const display = members.slice(0, MAX_MEMBERS).join(', ');
    const suffix = members.length > MAX_MEMBERS ? ', ...' : '';
    return `{ ${display}${suffix} }`;
  }

  // --- Resolution Helpers ---

  private tryResolveWithExtensions(
    basePath: string,
    extensions: string[],
    rootDir: string
  ): string | undefined {
    // Try exact path
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return path.relative(rootDir, basePath);
    }

    // Try provided extensions
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (fs.existsSync(fullPath)) {
        return path.relative(rootDir, fullPath);
      }
    }

    return undefined;
  }

  // --- Usage Analysis Helpers ---

  private isDeclaration(node: ts.Identifier): boolean {
    const { parent } = node;
    if (!parent) return false;

    return (
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node)
    );
  }

  private isInImportDeclaration(node: ts.Node): boolean {
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isImportDeclaration(current)) return true;
      current = current.parent;
    }
    return false;
  }

  private getUsageType(node: ts.Identifier): Usage['type'] {
    const { parent } = node;
    if (!parent) return 'reference';

    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === node) {
      return 'call';
    }

    if (ts.isHeritageClause(parent)) {
      return parent.token === ts.SyntaxKind.ExtendsKeyword ? 'extend' : 'implement';
    }

    if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
      return 'spread';
    }

    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      return 'assign';
    }

    if (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression)) {
      return 'pass';
    }

    return ts.isReturnStatement(parent) ? 'return' : 'reference';
  }
}