import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { glob } from 'glob';

export interface ExportInfo {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'const' | 'unknown';
  filePath: string;
  line: number;
  isDefault: boolean;
  isReExport?: boolean;
  originalSource?: string;
  signature?: string;
}

interface ImportInfo {
  name: string;
  alias?: string;
  source: string;
  filePath: string;
  line: number;
  isDefault: boolean;
  resolvedPath?: string;
}

interface UsageInfo {
  filePath: string;
  line: number;
  context: string;
  usageType: 'call' | 'reference' | 'extend' | 'implement' | 'spread' | 'assign' | 'pass' | 'return';
}

export interface SymbolTrace {
  symbol: ExportInfo;
  importedBy: Array<{
    file: string;
    alias?: string;
    line: number;
  }>;
  usages: UsageInfo[];
  dependents: string[];
  usageCount: number;
}

interface FileAnalysis {
  filePath: string;
  exports: ExportInfo[];
  imports: ImportInfo[];
  localSymbols: Map<string, { source: string; originalName: string }>;
}

export interface ProjectAnalysis {
  files: Map<string, FileAnalysis>;
  exports: Map<string, ExportInfo[]>;
  importGraph: Map<string, Set<string>>;
  reverseGraph: Map<string, Set<string>>;
  symbolTraces: Map<string, SymbolTrace>;
  circularDependencies: string[][];
}

interface AnalyzerConfig {
  entryPoints?: string[];
  ignore?: string[];
  cache?: boolean;
}

interface SerializedFileAnalysis {
  filePath: string;
  exports: ExportInfo[];
  imports: ImportInfo[];
  localSymbols: Record<string, { source: string; originalName: string }>;
}

interface CacheEntry {
  hash: string;
  analysis: SerializedFileAnalysis;
}

interface ProjectCache {
  version: string;
  files: Record<string, CacheEntry>;
}

export interface UnusedExport {
  export: ExportInfo;
  reason: string;
}

export interface BreakingChange {
  type: 'removed' | 'signature_changed' | 'type_changed';
  export: ExportInfo;
  details: string;
  affectedFiles: string[];
}

const CACHE_VERSION = '2.0';
const CACHE_DIR = '.consuela';
const CACHE_FILE = 'analysis-cache.json';

const DEFAULT_BLACKLIST = [
  'node_modules', '.git', 'dist', 'build', '.consuela',
  'tests', 'test', '__tests__', '*.test.*', '*.spec.*',
  '*.config.*', 'coverage',
];

export class ProjectAnalyzer {
  private readonly rootDir: string;
  private readonly blacklist: string[];
  private program: ts.Program | null = null;
  private checker: ts.TypeChecker | null = null;
  private readonly pathAliases: Map<string, string[]> = new Map();
  private baseUrl: string = '';
  private readonly config: AnalyzerConfig;
  private entryPointPatterns: string[] = [];
  private cache: ProjectCache | null = null;
  private readonly cacheEnabled: boolean;

  constructor(
    rootDir: string,
    blacklist: string[] = DEFAULT_BLACKLIST,
    config: AnalyzerConfig = {}
  ) {
    this.rootDir = rootDir;
    this.blacklist = [...blacklist, ...(config.ignore || [])];
    this.config = config;
    this.cacheEnabled = config.cache !== false;

    this.loadTsConfig();
    this.loadEntryPoints();
    if (this.cacheEnabled) {
      this.loadCache();
    }
  }

  private loadTsConfig(): void {
    const configPath = ts.findConfigFile(this.rootDir, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) return;

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const compilerOptions = configFile.config?.compilerOptions;

    if (compilerOptions?.baseUrl) {
      this.baseUrl = path.resolve(this.rootDir, compilerOptions.baseUrl);
    }

    if (compilerOptions?.paths) {
      for (const [alias, targets] of Object.entries(compilerOptions.paths as Record<string, string[]>)) {
        const aliasPrefix = alias.replace(/\*$/, '');
        const targetPaths = targets.map((t: string) =>
          path.resolve(this.baseUrl || this.rootDir, t.replace(/\*$/, ''))
        );
        this.pathAliases.set(aliasPrefix, targetPaths);
      }
    }
  }

  private loadEntryPoints(): void {
    this.entryPointPatterns = [
      'index.ts', 'index.tsx', 'index.js', 'index.jsx',
      'main.ts', 'main.tsx', 'main.js', 'main.jsx',
      'app.ts', 'app.tsx', 'app.js', 'app.jsx',
      'cli.ts', 'cli.js',
    ];

    if (this.config.entryPoints) {
      this.entryPointPatterns.push(...this.config.entryPoints);
    }

    const pkgPath = path.join(this.rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.main) this.entryPointPatterns.push(pkg.main.replace(/^\.\//, ''));

      if (pkg.bin) {
        const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin as Record<string, string>);
        bins.forEach(b => this.entryPointPatterns.push(b.replace(/^\.\//, '')));
      }

      if (pkg.exports) {
        this.extractExportsEntries(pkg.exports);
      }
    } catch {
      // Ignore parse errors
    }
  }

  private extractExportsEntries(exports: unknown): void {
    if (typeof exports === 'string') {
      this.entryPointPatterns.push(exports.replace(/^\.\//, ''));
    } else if (typeof exports === 'object' && exports !== null) {
      for (const [key, value] of Object.entries(exports)) {
        if (['import', 'require', 'default'].includes(key) || key.startsWith('.')) {
          this.extractExportsEntries(value);
        }
      }
    }
  }

  private loadCache(): void {
    const cacheFile = path.join(this.rootDir, CACHE_DIR, CACHE_FILE);
    if (!fs.existsSync(cacheFile)) return;

    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      if (data.version === CACHE_VERSION) {
        this.cache = data;
      }
    } catch {
      // Ignore cache errors
    }
  }

  private saveCache(files: Map<string, { hash: string; analysis: FileAnalysis }>): void {
    if (!this.cacheEnabled) return;

    const cacheDir = path.join(this.rootDir, CACHE_DIR);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const serializedFiles: Record<string, CacheEntry> = {};
    for (const [filePath, { hash, analysis }] of files) {
      serializedFiles[filePath] = {
        hash,
        analysis: {
          filePath: analysis.filePath,
          exports: analysis.exports,
          imports: analysis.imports,
          localSymbols: Object.fromEntries(analysis.localSymbols),
        },
      };
    }

    const cacheData: ProjectCache = { version: CACHE_VERSION, files: serializedFiles };
    fs.writeFileSync(path.join(cacheDir, CACHE_FILE), JSON.stringify(cacheData, null, 2));
  }

  private deserializeFileAnalysis(cached: SerializedFileAnalysis): FileAnalysis {
    return {
      filePath: cached.filePath,
      exports: cached.exports,
      imports: cached.imports,
      localSymbols: new Map(Object.entries(cached.localSymbols)),
    };
  }

  private getFileHash(filePath: string): string {
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('md5').update(content).digest('hex');
  }

  isEntryPoint(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return this.entryPointPatterns.some(pattern => {
      return normalized === pattern ||
             normalized.endsWith('/' + pattern) ||
             normalized.endsWith(pattern.replace(/^src\//, ''));
    });
  }

  async analyze(): Promise<ProjectAnalysis> {
    const files = await this.findSourceFiles();
    this.initializeTsProgram(files);

    const fileAnalyses = new Map<string, FileAnalysis>();
    const fileHashes = new Map<string, { hash: string; analysis: FileAnalysis }>();
    const allExports = new Map<string, ExportInfo[]>();
    const importGraph = new Map<string, Set<string>>();
    const reverseGraph = new Map<string, Set<string>>();
    const symbolTraces = new Map<string, SymbolTrace>();

    // Pass 1: Local file analysis and export registration
    for (const filePath of files) {
      const relativePath = path.relative(this.rootDir, filePath);
      const hash = this.getFileHash(filePath);
      
      const cached = this.cache?.files[relativePath];
      const analysis = (cached && cached.hash === hash)
        ? this.deserializeFileAnalysis(cached.analysis)
        : this.analyzeFile(filePath);

      fileAnalyses.set(relativePath, analysis);
      fileHashes.set(relativePath, { hash, analysis });

      for (const exp of analysis.exports) {
        const existing = allExports.get(exp.name) || [];
        existing.push(exp);
        allExports.set(exp.name, existing);

        const key = `${exp.filePath}:${exp.name}`;
        symbolTraces.set(key, {
          symbol: exp,
          importedBy: [],
          usages: [],
          dependents: [],
          usageCount: 0,
        });
      }
    }

    // Pass 2: Map imports and link to traces
    for (const [relativePath, analysis] of fileAnalyses) {
      const imports = new Set<string>();
      for (const imp of analysis.imports) {
        if (imp.resolvedPath) {
          imports.add(imp.resolvedPath);
          const importers = reverseGraph.get(imp.resolvedPath) || new Set();
          importers.add(relativePath);
          reverseGraph.set(imp.resolvedPath, importers);

          const trace = symbolTraces.get(`${imp.resolvedPath}:${imp.name}`);
          if (trace) {
            trace.importedBy.push({ file: relativePath, alias: imp.alias, line: imp.line });
          }
        }
      }
      importGraph.set(relativePath, imports);
    }

    // Pass 3 & 4: Re-exports and Usage tracing
    this.resolveReExports(fileAnalyses, symbolTraces, allExports);

    for (const filePath of files) {
      const relativePath = path.relative(this.rootDir, filePath);
      this.findUsagesInFile(filePath, fileAnalyses.get(relativePath)!, symbolTraces);
    }

    // Pass 5: Finalize traces and calculate transitive impact
    for (const [, trace] of symbolTraces) {
      const dependents = new Set<string>();
      for (const imp of trace.importedBy) {
        dependents.add(imp.file);
        this.getTransitiveDependents(imp.file, reverseGraph).forEach(t => dependents.add(t));
      }
      trace.dependents = Array.from(dependents);
      trace.usageCount = trace.usages.length;
    }

    this.saveCache(fileHashes);

    return {
      files: fileAnalyses,
      exports: allExports,
      importGraph,
      reverseGraph,
      symbolTraces,
      circularDependencies: this.detectCircularDependencies(importGraph),
    };
  }

  private initializeTsProgram(files: string[]): void {
    const configPath = ts.findConfigFile(this.rootDir, ts.sys.fileExists, 'tsconfig.json');
    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, this.rootDir);
      this.program = ts.createProgram(files, parsedConfig.options);
      this.checker = this.program.getTypeChecker();
    }
  }

  private resolveReExports(
    fileAnalyses: Map<string, FileAnalysis>,
    symbolTraces: Map<string, SymbolTrace>,
    allExports: Map<string, ExportInfo[]>
  ): void {
    // Resolve named re-exports kinds
    for (const [, analysis] of fileAnalyses) {
      for (const exp of analysis.exports) {
        if (exp.isReExport && exp.originalSource && exp.name !== '*') {
          const sourceAnalysis = fileAnalyses.get(exp.originalSource);
          const sourceExport = sourceAnalysis?.exports.find(e => e.name === exp.name);
          if (sourceExport) {
            exp.kind = sourceExport.kind;
            exp.signature = sourceExport.signature;
          }
        }
      }
    }

    // Expand star exports
    for (const [filePath, analysis] of fileAnalyses) {
      const starExports = analysis.exports.filter(e => e.name === '*' && e.originalSource);
      for (const star of starExports) {
        const sourceAnalysis = fileAnalyses.get(star.originalSource!);
        if (!sourceAnalysis) continue;

        for (const sourceExport of sourceAnalysis.exports) {
          if (sourceExport.name === '*' || sourceExport.name === 'default') continue;

          const reExport: ExportInfo = {
            ...sourceExport,
            filePath,
            isReExport: true,
            originalSource: star.originalSource,
          };

          analysis.exports.push(reExport);
          const existing = allExports.get(sourceExport.name) || [];
          existing.push(reExport);
          allExports.set(sourceExport.name, existing);

          const key = `${filePath}:${sourceExport.name}`;
          if (!symbolTraces.has(key)) {
            symbolTraces.set(key, { symbol: reExport, importedBy: [], usages: [], dependents: [], usageCount: 0 });
          }
        }
      }
    }
  }

  private detectCircularDependencies(importGraph: Map<string, Set<string>>): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const currentPath: string[] = [];

    const dfs = (file: string) => {
      visited.add(file);
      recursionStack.add(file);
      currentPath.push(file);

      const imports = importGraph.get(file);
      if (imports) {
        for (const imported of imports) {
          if (!visited.has(imported)) {
            dfs(imported);
          } else if (recursionStack.has(imported)) {
            const cycleStart = currentPath.indexOf(imported);
            if (cycleStart !== -1) {
              const cycle = currentPath.slice(cycleStart);
              const cycleKey = [...cycle].sort().join('|');
              if (!cycles.some(c => [...c].sort().join('|') === cycleKey)) {
                cycles.push([...cycle]);
              }
            }
          }
        }
      }

      currentPath.pop();
      recursionStack.delete(file);
    };

    for (const file of importGraph.keys()) {
      if (!visited.has(file)) dfs(file);
    }
    return cycles;
  }

  private async findSourceFiles(): Promise<string[]> {
    const patterns = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'];
    const ignorePatterns = this.blacklist.map(b => b.includes('*') ? `**/${b}` : `**/${b}/**`);

    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: this.rootDir,
        absolute: true,
        ignore: ignorePatterns,
      });
      files.push(...matches);
    }
    return files;
  }

  private analyzeFile(filePath: string): FileAnalysis {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.rootDir, filePath);
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, this.getScriptKind(filePath));

    const exports: ExportInfo[] = [];
    const imports: ImportInfo[] = [];
    const localSymbols = new Map<string, { source: string; originalName: string }>();

    // Pass 1: Collect imports first so we know what symbols are imported
    const visitImports = (node: ts.Node) => {
      if (ts.isImportDeclaration(node)) {
        this.handleImportDeclaration(node, sourceFile, relativePath, imports, localSymbols);
      }
      ts.forEachChild(node, visitImports);
    };
    visitImports(sourceFile);

    // Pass 2: Collect exports (now we know which symbols are imported for re-export detection)
    const visitExports = (node: ts.Node) => {
      if (ts.isExportDeclaration(node)) {
        this.handleExportDeclaration(node, sourceFile, relativePath, exports, localSymbols);
      } else if (ts.isExportAssignment(node)) {
        this.handleExportAssignment(node, sourceFile, relativePath, exports);
      } else if (this.hasExportModifier(node)) {
        this.handleExportedDeclaration(node, sourceFile, relativePath, exports);
      }
      ts.forEachChild(node, visitExports);
    };
    visitExports(sourceFile);

    return { filePath: relativePath, exports, imports, localSymbols };
  }

  private getScriptKind(filePath: string): ts.ScriptKind {
    if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return ts.ScriptKind.JS;
    return ts.ScriptKind.TS;
  }

  private hasExportModifier(node: ts.Node): boolean {
    return ts.canHaveModifiers(node) && 
           ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) === true;
  }

  private handleExportDeclaration(
    node: ts.ExportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    exports: ExportInfo[],
    localSymbols?: Map<string, { source: string; originalName: string }>
  ) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const source = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
    const resolvedPath = source ? this.resolveImportPath(filePath, source) : undefined;

    if (!node.exportClause && resolvedPath) {
      exports.push({ name: '*', kind: 'unknown', filePath, line, isDefault: false, isReExport: true, originalSource: resolvedPath });
      return;
    }

    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        const exportedName = element.name.text;
        const localName = element.propertyName?.text || exportedName;

        // Check if this is a "local re-export" - exporting an imported symbol without a module specifier
        // e.g., import { foo } from './bar'; export { foo };
        let isLocalReExport = false;
        let localReExportSource: string | undefined;

        if (!source && localSymbols) {
          const localInfo = localSymbols.get(localName);
          if (localInfo) {
            isLocalReExport = true;
            localReExportSource = localInfo.source;
          }
        }

        exports.push({
          name: exportedName,
          kind: 'unknown',
          filePath,
          line,
          isDefault: false,
          isReExport: !!source || isLocalReExport,
          originalSource: resolvedPath || localReExportSource
        });
      }
    }
  }

  private handleExportAssignment(node: ts.ExportAssignment, sourceFile: ts.SourceFile, filePath: string, exports: ExportInfo[]) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    exports.push({ name: 'default', kind: 'unknown', filePath, line, isDefault: true });
  }

  private handleExportedDeclaration(node: ts.Node, sourceFile: ts.SourceFile, filePath: string, exports: ExportInfo[]) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : [];
    const isDefault = modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

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
            kind: isConst ? 'const' : 'variable',
            filePath,
            line,
            isDefault: false,
            signature: decl.type?.getText(sourceFile),
          });
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      exports.push({ name: node.name.text, kind: 'interface', filePath, line, isDefault: false, signature: this.getInterfaceSignature(node, sourceFile) });
    } else if (ts.isTypeAliasDeclaration(node)) {
      exports.push({ name: node.name.text, kind: 'type', filePath, line, isDefault: false, signature: node.type.getText(sourceFile).slice(0, 100) });
    } else if (ts.isEnumDeclaration(node)) {
      exports.push({ name: node.name.text, kind: 'enum', filePath, line, isDefault: false });
    }
  }

  private getFunctionSignature(node: ts.FunctionDeclaration, sourceFile: ts.SourceFile): string {
    const params = node.parameters.map(p => {
      const type = p.type ? `: ${p.type.getText(sourceFile)}` : '';
      return `${p.name.getText(sourceFile)}${p.questionToken ? '?' : ''}${type}`;
    }).join(', ');
    return `(${params})${node.type ? `: ${node.type.getText(sourceFile)}` : ''}`;
  }

  private getClassSignature(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): string {
    const members = node.members.filter(m => {
      const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : [];
      return !mods?.some(mod => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword);
    }).map(m => m.name ? m.name.getText(sourceFile) + (ts.isMethodDeclaration(m) ? '()' : '') : '').filter(Boolean);
    
    return `{ ${members.slice(0, 5).join(', ')}${members.length > 5 ? ', ...' : ''} }`;
  }

  private getInterfaceSignature(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string {
    const members = node.members.map(m => {
      if (m.name) return m.name.getText(sourceFile) + (ts.isMethodSignature(m) ? '()' : '');
      return '';
    }).filter(Boolean);
    return `{ ${members.slice(0, 5).join(', ')}${members.length > 5 ? ', ...' : ''} }`;
  }

  private handleImportDeclaration(
    node: ts.ImportDeclaration,
    sourceFile: ts.SourceFile,
    filePath: string,
    imports: ImportInfo[],
    localSymbols: Map<string, { source: string; originalName: string }>
  ) {
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;

    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const source = node.moduleSpecifier.text;
    const resolvedPath = this.resolveImportPath(filePath, source);
    const clause = node.importClause;

    if (clause) {
      if (clause.name && resolvedPath) {
        const local = clause.name.text;
        imports.push({ name: 'default', alias: local, source, filePath, line, isDefault: true, resolvedPath });
        localSymbols.set(local, { source: resolvedPath, originalName: 'default' });
      }

      if (clause.namedBindings && resolvedPath) {
        if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const original = el.propertyName?.text || el.name.text;
            const local = el.name.text;
            imports.push({ name: original, alias: el.propertyName ? local : undefined, source, filePath, line, isDefault: false, resolvedPath });
            localSymbols.set(local, { source: resolvedPath, originalName: original });
          }
        } else if (ts.isNamespaceImport(clause.namedBindings)) {
          const local = clause.namedBindings.name.text;
          imports.push({ name: '*', alias: local, source, filePath, line, isDefault: false, resolvedPath });
          localSymbols.set(local, { source: resolvedPath, originalName: '*' });
        }
      }
    }
  }

  private resolveImportPath(fromFile: string, importPath: string): string | undefined {
    let normalizedPath = importPath.replace(/\.(js|mjs|jsx)$/, '');
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

    if (normalizedPath.startsWith('.')) {
      const resolved = path.resolve(path.dirname(path.join(this.rootDir, fromFile)), normalizedPath);
      return this.tryResolveWithExtensions(resolved, extensions);
    }

    for (const [prefix, targets] of this.pathAliases) {
      if (normalizedPath.startsWith(prefix)) {
        const remainder = normalizedPath.slice(prefix.length);
        for (const target of targets) {
          const result = this.tryResolveWithExtensions(path.join(target, remainder), extensions);
          if (result) return result;
        }
      }
    }

    if (this.baseUrl) {
      return this.tryResolveWithExtensions(path.join(this.baseUrl, normalizedPath), extensions);
    }

    return undefined;
  }

  private tryResolveWithExtensions(basePath: string, extensions: string[]): string | undefined {
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return path.relative(this.rootDir, basePath);
    }
    for (const ext of extensions) {
      if (fs.existsSync(basePath + ext)) return path.relative(this.rootDir, basePath + ext);
    }
    return undefined;
  }

  private findUsagesInFile(filePath: string, fileAnalysis: FileAnalysis, symbolTraces: Map<string, SymbolTrace>) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Get the source file from the program if available (for proper symbol resolution)
    const programSourceFile = this.program?.getSourceFile(filePath);
    const sourceFile = programSourceFile || ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, this.getScriptKind(filePath));

    // Build a map of exports defined in THIS file for same-file usage tracking
    const localExports = new Map<string, { traceKey: string; declarationLine: number }>();
    for (const exp of fileAnalysis.exports) {
      const traceKey = `${fileAnalysis.filePath}:${exp.name}`;
      if (symbolTraces.has(traceKey)) {
        localExports.set(exp.name, { traceKey, declarationLine: exp.line });
      }
    }

    const record = (traceKey: string, node: ts.Node, usageType: UsageInfo['usageType']) => {
      const trace = symbolTraces.get(traceKey);
      if (trace) {
        const lineIdx = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
        trace.usages.push({ filePath: fileAnalysis.filePath, line: lineIdx + 1, context: lines[lineIdx]?.trim() || '', usageType });
      }
    };

    // Helper to check if an identifier actually refers to an imported symbol
    // using the TypeScript type checker for proper scope resolution
    const getImportedSymbolInfo = (node: ts.Identifier): { source: string; originalName: string } | undefined => {
      const localInfo = fileAnalysis.localSymbols.get(node.text);
      if (!localInfo) return undefined;

      // If we have a type checker, verify the symbol actually refers to the import
      if (this.checker && programSourceFile) {
        const symbol = this.checker.getSymbolAtLocation(node);
        if (symbol) {
          // Get the symbol's declarations
          const declarations = symbol.declarations;
          if (declarations && declarations.length > 0) {
            const decl = declarations[0];
            // Check if this declaration is an import specifier or import clause
            // If it is, this identifier refers to the imported symbol
            // If it's a variable declaration or parameter, it's a local that shadows the import
            if (ts.isImportSpecifier(decl) ||
                ts.isImportClause(decl) ||
                ts.isNamespaceImport(decl)) {
              return localInfo;
            }
            // The symbol was declared locally (shadowing the import)
            // This is NOT a usage of the imported symbol
            return undefined;
          }
        }
      }

      // Fallback: if no type checker, use the simple name matching
      // This is less accurate but still works for most cases
      return localInfo;
    };

    // Helper to check if node is part of an export declaration (to avoid counting definitions as usages)
    const isPartOfExportDeclaration = (node: ts.Node): boolean => {
      let current: ts.Node | undefined = node.parent;
      while (current) {
        // Skip if it's the name in a function/class/variable declaration that is exported
        if (ts.isFunctionDeclaration(current) && current.name === node) return true;
        if (ts.isClassDeclaration(current) && current.name === node) return true;
        if (ts.isVariableDeclaration(current) && current.name === node) return true;
        if (ts.isInterfaceDeclaration(current) && current.name === node) return true;
        if (ts.isTypeAliasDeclaration(current) && current.name === node) return true;
        if (ts.isEnumDeclaration(current) && current.name === node) return true;
        // Also skip export { name } declarations
        if (ts.isExportSpecifier(current)) return true;
        current = current.parent;
      }
      return false;
    };

    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;

      // JSX Components
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (ts.isIdentifier(node.tagName)) {
          const info = getImportedSymbolInfo(node.tagName);
          if (info) record(`${info.source}:${info.originalName}`, node, 'call');
        } else if (ts.isPropertyAccessExpression(node.tagName) && ts.isIdentifier(node.tagName.expression)) {
          const info = getImportedSymbolInfo(node.tagName.expression);
          if (info?.originalName === '*') record(`${info.source}:${node.tagName.name.text}`, node, 'call');
        }
      }

      // Identifiers & Property Access
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isJsxTag = parent && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && (parent as any).tagName === node;

        if (!isJsxTag) {
          // Check imported symbols first
          const info = getImportedSymbolInfo(node);
          if (info) {
            record(`${info.source}:${info.originalName}`, node, this.determineUsageType(node));
          } else {
            // Check same-file exports (not already imported)
            const localExport = localExports.get(node.text);
            if (localExport && !isPartOfExportDeclaration(node)) {
              record(localExport.traceKey, node, this.determineUsageType(node));
            }
          }
        }
      }

      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const info = getImportedSymbolInfo(node.expression);
        if (info?.originalName === '*') record(`${info.source}:${node.name.text}`, node, this.determineUsageType(node));
      }

      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const info = getImportedSymbolInfo(node.typeName);
        if (info) {
          record(`${info.source}:${info.originalName}`, node, 'reference');
        } else {
          // Check same-file type exports
          const localExport = localExports.get(node.typeName.text);
          if (localExport && !isPartOfExportDeclaration(node.typeName)) {
            record(localExport.traceKey, node, 'reference');
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  private determineUsageType(node: ts.Node): UsageInfo['usageType'] {
    const parent = node.parent;
    if (!parent) return 'reference';

    if (ts.isCallExpression(parent) && (parent.expression === node || (ts.isPropertyAccessExpression(parent.expression) && parent.expression === node))) return 'call';
    if (ts.isHeritageClause(parent)) return parent.token === ts.SyntaxKind.ExtendsKeyword ? 'extend' : 'implement';
    if (ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent) || ts.isJsxSpreadAttribute(parent)) return 'spread';
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return 'assign';
    if (ts.isCallExpression(parent) && parent.arguments.includes(node as any)) return 'pass';
    if (ts.isReturnStatement(parent)) return 'return';

    return 'reference';
  }

  private getTransitiveDependents(file: string, reverseGraph: Map<string, Set<string>>): Set<string> {
    const dependents = new Set<string>();
    const queue = [file];

    while (queue.length > 0) {
      const current = queue.shift()!;
      reverseGraph.get(current)?.forEach(importer => {
        if (!dependents.has(importer)) {
          dependents.add(importer);
          queue.push(importer);
        }
      });
    }
    return dependents;
  }

  findUnusedExports(analysis: ProjectAnalysis): UnusedExport[] {
    const unused: UnusedExport[] = [];
    const reExportMap = new Map<string, string[]>();

    for (const [key, trace] of analysis.symbolTraces) {
      if (trace.symbol.isReExport && trace.symbol.originalSource) {
        const orig = `${trace.symbol.originalSource}:${trace.symbol.name}`;
        reExportMap.set(orig, [...(reExportMap.get(orig) || []), key]);
      }
    }

    for (const [key, trace] of analysis.symbolTraces) {
      if (trace.symbol.name === '*') continue;

      const isEntry = this.isEntryPoint(trace.symbol.filePath);
      const isUsedViaReExport = trace.symbol.isReExport && trace.importedBy.length > 0;
      const isUsedViaOtherReExport = (reExportMap.get(key) || []).some(reKey => {
        const reTrace = analysis.symbolTraces.get(reKey);
        return reTrace && (reTrace.importedBy.length > 0 || reTrace.usages.length > 0);
      });

      const isUsed = trace.importedBy.length > 0 || trace.usages.length > 0 || isUsedViaReExport || isUsedViaOtherReExport;

      if (!isUsed) {
        unused.push({ export: trace.symbol, reason: isEntry ? 'Entry point - may be used externally' : 'Never imported or used' });
      } else if (trace.importedBy.length > 0 && trace.usages.length === 0 && !isUsedViaReExport && !isUsedViaOtherReExport) {
        if (trace.symbol.kind !== 'type' && trace.symbol.kind !== 'interface') {
          unused.push({ export: trace.symbol, reason: `Imported by ${trace.importedBy.length} file(s) but never actually used` });
        }
      }
    }
    return unused;
  }

  getSymbolTrace(analysis: ProjectAnalysis, filePath: string, symbolName: string): SymbolTrace | undefined {
    const rel = filePath.startsWith(this.rootDir) ? path.relative(this.rootDir, filePath) : filePath;
    return analysis.symbolTraces.get(`${rel}:${symbolName}`);
  }

  getImpact(analysis: ProjectAnalysis, filePath: string): string[] {
    const rel = path.relative(this.rootDir, path.resolve(this.rootDir, filePath));
    return Array.from(this.getTransitiveDependents(rel, analysis.reverseGraph));
  }

  compareExports(oldAnalysis: ProjectAnalysis, newAnalysis: ProjectAnalysis): BreakingChange[] {
    const changes: BreakingChange[] = [];
    for (const [key, oldTrace] of oldAnalysis.symbolTraces) {
      const newTrace = newAnalysis.symbolTraces.get(key);
      if (!newTrace) {
        changes.push({ type: 'removed', export: oldTrace.symbol, details: `Export "${oldTrace.symbol.name}" was removed from ${oldTrace.symbol.filePath}`, affectedFiles: oldTrace.dependents });
      } else if (oldTrace.symbol.signature && newTrace.symbol.signature !== oldTrace.symbol.signature) {
        changes.push({ type: 'signature_changed', export: oldTrace.symbol, details: `Signature changed:\n  Old: ${oldTrace.symbol.signature}\n  New: ${newTrace.symbol.signature}`, affectedFiles: oldTrace.dependents });
      }
    }
    return changes;
  }
}

export const createAnalyzer = (rootDir: string, blacklist?: string[], config?: AnalyzerConfig): ProjectAnalyzer => {
  return new ProjectAnalyzer(rootDir, blacklist, config);
};