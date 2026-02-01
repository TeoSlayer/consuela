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
 * Python language parser
 * Uses regex-based parsing for simplicity (no external dependencies)
 * For production, consider using tree-sitter-python
 */
export class PythonParser implements LanguageParser {
  readonly id = 'python';
  readonly name = 'Python';
  readonly extensions = ['.py'];

  private readonly MAX_SIGNATURE_SCAN_LINES = 10;
  private readonly MAX_CLASS_METHODS_IN_SIGNATURE = 5;

  parseFile(filePath: string, content: string): FileParseResult {
    const exports: Export[] = [];
    const imports: Import[] = [];
    const localSymbols = new Map<string, LocalSymbol>();
    const lines = content.split('\n');

    // Track __all__ if defined (explicit exports)
    let explicitExports: string[] | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Handle __all__ export definitions
      if (line.startsWith('__all__')) {
        const allMatch = line.match(/^__all__\s*=\s*\[(.*)\]/);
        if (allMatch) {
          // Single line __all__ = ["a", "b"]
          explicitExports = this.extractNamesFromList(allMatch[1]);
        } else if (line.match(/^__all__\s*=\s*\[/)) {
          // Multi-line __all__ = [ ... ]
          const buffer = [];
          let j = i;
          while (j < lines.length) {
            buffer.push(lines[j]);
            if (lines[j].includes(']')) break;
            j++;
          }
          const fullContent = buffer.join('');
          const contentMatch = fullContent.match(/\[(.*)\]/s);
          if (contentMatch) {
            explicitExports = this.extractNamesFromList(contentMatch[1]);
          }
          // Move index to the end of the __all__ definition
          i = j;
        }
        continue;
      }

      // Parse imports
      this.parseImportLine(line, lineNum, filePath, imports, localSymbols);

      // Parse top-level definitions (potential exports)
      this.parseDefinition(line, lineNum, filePath, exports, lines, i);
    }

    // Process exports based on visibility rules
    let finalExports: Export[];

    if (explicitExports) {
      const exportSet = new Set(explicitExports);
      // Include only those in __all__
      finalExports = exports.filter((exp) => exportSet.has(exp.name));

      // Add placeholder exports for names in __all__ not found via static analysis
      for (const name of explicitExports) {
        if (!finalExports.some((exp) => exp.name === name)) {
          finalExports.push({
            name,
            kind: 'unknown',
            filePath,
            line: 1,
            isDefault: false,
          });
        }
      }
    } else {
      // Default Python behavior: filter to public names (not starting with _)
      finalExports = exports.filter((exp) => !exp.name.startsWith('_'));
    }

    return { filePath, exports: finalExports, imports, localSymbols };
  }

  resolveImport(
    importSource: string,
    fromFile: string,
    config: ResolverConfig
  ): string | undefined {
    // Handle relative imports (e.g., .module or ..parent)
    if (importSource.startsWith('.')) {
      const dotsMatch = importSource.match(/^\.+/);
      const dots = dotsMatch?.[0] || '.';
      const levels = dots.length;
      const modulePath = importSource.slice(levels);

      let baseDir = path.dirname(path.join(config.rootDir, fromFile));
      // Python's leading dots: . is current dir, .. is parent, ... is grandparent
      for (let i = 1; i < levels; i++) {
        baseDir = path.dirname(baseDir);
      }

      const moduleParts = modulePath.split('.').filter(Boolean);
      const resolved = path.join(baseDir, ...moduleParts);

      return this.tryResolvePythonModule(resolved, config.rootDir);
    }

    // Handle absolute imports (relative to rootDir/PYTHONPATH)
    const moduleParts = importSource.split('.');
    const resolved = path.join(config.rootDir, ...moduleParts);
    return this.tryResolvePythonModule(resolved, config.rootDir);
  }

  findUsages(
    filePath: string,
    content: string,
    symbolName: string,
    localSymbols: Map<string, LocalSymbol>
  ): Usage[] {
    const usages: Usage[] = [];
    const lines = content.split('\n');
    const escapedName = this.escapeRegex(symbolName);
    const identifierRegex = new RegExp(`\\b${escapedName}\\b`, 'g');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip import lines and definition lines to find only real usages
      if (line.match(/^\s*(from|import)\s/)) continue;
      if (line.match(new RegExp(`^\\s*(def|class|async\\s+def)\\s+${escapedName}\\b`))) continue;
      if (line.match(new RegExp(`^\\s*${escapedName}\\s*=`))) continue;

      if (identifierRegex.test(line)) {
        usages.push({
          filePath,
          line: lineNum,
          context: line.trim(),
          type: this.getUsageType(line, symbolName),
        });
      }
    }

    return usages;
  }

  getTidyPrompt(): string {
    return `You are refactoring Python code. Focus on:
- PEP 8 style compliance
- Type hints (Python 3.9+ style)
- F-strings over .format() or %
- Context managers where appropriate
- List/dict comprehensions where readable
- Proper docstrings (Google or NumPy style)`;
  }

  // --- Private Helpers ---

  private parseImportLine(
    line: string,
    lineNum: number,
    filePath: string,
    imports: Import[],
    localSymbols: Map<string, LocalSymbol>
  ): void {
    // 1. Handle "from X import Y, Z"
    const fromMatch = line.match(/^\s*from\s+([\w.]+)\s+import\s+(.+)$/);
    if (fromMatch) {
      const source = fromMatch[1];
      const importsPart = fromMatch[2].trim();

      if (importsPart === '*') {
        imports.push({ name: '*', source, filePath, line: lineNum, isDefault: false });
        return;
      }

      const items = this.parseImportItems(importsPart);
      for (const item of items) {
        imports.push({
          name: item.name,
          alias: item.alias,
          source,
          filePath,
          line: lineNum,
          isDefault: false,
        });
        localSymbols.set(item.alias || item.name, { source, originalName: item.name });
      }
      return;
    }

    // 2. Handle "import X, Y as Z"
    const importMatch = line.match(/^\s*import\s+(.+)$/);
    if (importMatch) {
      const items = this.parseImportItems(importMatch[1]);
      for (const item of items) {
        imports.push({
          name: item.name,
          alias: item.alias,
          source: item.name,
          filePath,
          line: lineNum,
          isDefault: false,
        });
        // In "import a.b", the root accessible symbol is usually "a" unless aliased
        const localName = item.alias || item.name.split('.')[0];
        localSymbols.set(localName, { source: item.name, originalName: item.name });
      }
    }
  }

  private parseImportItems(importStr: string): Array<{ name: string; alias?: string }> {
    const items: Array<{ name: string; alias?: string }> = [];
    const cleaned = importStr.replace(/[()]/g, '').trim();
    const parts = cleaned.split(',').map((s) => s.trim()).filter(Boolean);

    for (const part of parts) {
      const asMatch = part.match(/^([\w.]+)\s+as\s+(\w+)$/);
      if (asMatch) {
        items.push({ name: asMatch[1], alias: asMatch[2] });
      } else {
        items.push({ name: part });
      }
    }
    return items;
  }

  private parseDefinition(
    line: string,
    lineNum: number,
    filePath: string,
    exports: Export[],
    lines: string[],
    lineIndex: number
  ): void {
    // Only process top-level definitions (no leading whitespace)
    if (/^\s/.test(line)) return;

    // Functions
    const funcMatch = line.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    if (funcMatch) {
      exports.push({
        name: funcMatch[2],
        kind: 'function',
        filePath,
        line: lineNum,
        isDefault: false,
        signature: this.extractFunctionSignature(lines, lineIndex),
      });
      return;
    }

    // Classes
    const classMatch = line.match(/^class\s+(\w+)/);
    if (classMatch) {
      exports.push({
        name: classMatch[1],
        kind: 'class',
        filePath,
        line: lineNum,
        isDefault: false,
        signature: this.extractClassSignature(lines, lineIndex),
      });
      return;
    }

    // Constants (UPPER_CASE)
    const constMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*[=:]/);
    if (constMatch) {
      exports.push({ name: constMatch[1], kind: 'constant', filePath, line: lineNum, isDefault: false });
      return;
    }

    // Variables (lower_case)
    const varMatch = line.match(/^([a-z_][a-z0-9_]*)\s*[=:]/);
    if (varMatch && !line.includes('import')) {
      exports.push({ name: varMatch[1], kind: 'variable', filePath, line: lineNum, isDefault: false });
    }
  }

  private extractFunctionSignature(lines: string[], startIndex: number): string {
    let signature = '';
    let parenCount = 0;
    let hasStarted = false;

    const limit = Math.min(lines.length, startIndex + this.MAX_SIGNATURE_SCAN_LINES);

    for (let i = startIndex; i < limit; i++) {
      const line = lines[i];
      for (const char of line) {
        if (char === '(') {
          hasStarted = true;
          parenCount++;
        }
        if (hasStarted) signature += char;
        if (char === ')') {
          parenCount--;
          if (parenCount === 0) {
            // Include potential return type hint: def name() -> str:
            const remaining = line.slice(line.indexOf(')', signature.length - 1) + 1);
            const returnMatch = remaining.match(/\s*->\s*([^:]+)/);
            if (returnMatch) {
              signature += ` -> ${returnMatch[1].trim()}`;
            }
            return signature;
          }
        }
      }
      if (hasStarted) signature += ' ';
    }

    return signature || '()';
  }

  private extractClassSignature(lines: string[], startIndex: number): string {
    const methods: string[] = [];
    const baseIndent = this.getIndent(lines[startIndex]);

    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;

      const indent = this.getIndent(line);
      if (indent <= baseIndent) break;

      const methodMatch = line.match(/^\s+def\s+(\w+)\s*\(/);
      if (methodMatch && !methodMatch[1].startsWith('_')) {
        methods.push(`${methodMatch[1]}()`);
        if (methods.length >= this.MAX_CLASS_METHODS_IN_SIGNATURE) break;
      }
    }

    return methods.length > 0 ? `{ ${methods.join(', ')} }` : '{}';
  }

  private getIndent(line: string): number {
    return line.match(/^(\s*)/)?.[0].length || 0;
  }

  private extractNamesFromList(listStr: string): string[] {
    return listStr
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
  }

  private tryResolvePythonModule(basePath: string, rootDir: string): string | undefined {
    const pyFile = `${basePath}.py`;
    if (fs.existsSync(pyFile)) {
      return path.relative(rootDir, pyFile);
    }

    const initFile = path.join(basePath, '__init__.py');
    if (fs.existsSync(initFile)) {
      return path.relative(rootDir, initFile);
    }

    return undefined;
  }

  private getUsageType(line: string, symbolName: string): Usage['type'] {
    const trimmed = line.trim();
    const escaped = this.escapeRegex(symbolName);

    if (new RegExp(`\\b${escaped}\\s*\\(`).test(trimmed)) return 'call';
    if (trimmed.match(/^class\s+\w+\s*\(/) && trimmed.includes(symbolName)) return 'extend';
    if (trimmed.includes(`*${symbolName}`) || trimmed.includes(`**${symbolName}`)) return 'spread';
    if (new RegExp(`^${escaped}\\s*=`).test(trimmed)) return 'assign';
    if (trimmed.startsWith('return ') && trimmed.includes(symbolName)) return 'return';
    if (trimmed.includes('(') && trimmed.includes(symbolName)) return 'pass';

    return 'reference';
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}