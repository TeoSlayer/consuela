import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'node:path';
import { createAnalyzer, type ProjectAnalysis } from '../../src/core/analyzer.js';

const FIXTURES_DIR = path.join(__dirname, '../fixtures');

describe('ProjectAnalyzer', () => {
  describe('simple project', () => {
    let analysis: ProjectAnalysis;
    let analyzer: ReturnType<typeof createAnalyzer>;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('finds all source files', () => {
      expect(analysis.files.size).toBe(2);
      expect(analysis.files.has('src/utils.ts')).toBe(true);
      expect(analysis.files.has('src/index.ts')).toBe(true);
    });

    it('extracts function exports', () => {
      const utilsExports = analysis.files.get('src/utils.ts')?.exports;
      const functions = utilsExports?.filter(e => e.kind === 'function');

      expect(functions).toHaveLength(2);
      expect(functions?.map(f => f.name)).toContain('usedFunction');
      expect(functions?.map(f => f.name)).toContain('unusedFunction');
    });

    it('extracts class exports', () => {
      const utilsExports = analysis.files.get('src/utils.ts')?.exports;
      const classes = utilsExports?.filter(e => e.kind === 'class');

      expect(classes).toHaveLength(2);
      expect(classes?.map(c => c.name)).toContain('UsedClass');
      expect(classes?.map(c => c.name)).toContain('UnusedClass');
    });

    it('extracts type exports', () => {
      const utilsExports = analysis.files.get('src/utils.ts')?.exports;
      const types = utilsExports?.filter(e => e.kind === 'type');

      expect(types).toHaveLength(2);
      expect(types?.map(t => t.name)).toContain('UsedType');
      expect(types?.map(t => t.name)).toContain('UnusedType');
    });

    it('extracts const exports', () => {
      const utilsExports = analysis.files.get('src/utils.ts')?.exports;
      const consts = utilsExports?.filter(e => e.kind === 'const');

      expect(consts).toHaveLength(2);
      expect(consts?.map(c => c.name)).toContain('USED_CONST');
      expect(consts?.map(c => c.name)).toContain('UNUSED_CONST');
    });

    it('tracks imports correctly', () => {
      const indexImports = analysis.files.get('src/index.ts')?.imports;

      expect(indexImports).toBeDefined();
      expect(indexImports?.length).toBeGreaterThan(0);

      const usedFunctionImport = indexImports?.find(i => i.name === 'usedFunction');
      expect(usedFunctionImport).toBeDefined();
      expect(usedFunctionImport?.resolvedPath).toBe('src/utils.ts');
    });

    it('builds import graph', () => {
      const indexDeps = analysis.importGraph.get('src/index.ts');

      expect(indexDeps).toBeDefined();
      expect(indexDeps?.has('src/utils.ts')).toBe(true);
    });

    it('builds reverse graph', () => {
      const utilsDependents = analysis.reverseGraph.get('src/utils.ts');

      expect(utilsDependents).toBeDefined();
      expect(utilsDependents?.has('src/index.ts')).toBe(true);
    });

    it('tracks symbol usages', () => {
      const usedFunctionTrace = analysis.symbolTraces.get('src/utils.ts:usedFunction');

      expect(usedFunctionTrace).toBeDefined();
      expect(usedFunctionTrace?.usageCount).toBeGreaterThan(0);
      expect(usedFunctionTrace?.importedBy.length).toBeGreaterThan(0);
    });

    it('identifies unused exports', () => {
      const unused = analyzer.findUnusedExports(analysis);
      const unusedNames = unused.map(u => u.export.name);

      expect(unusedNames).toContain('unusedFunction');
      expect(unusedNames).toContain('UnusedClass');
      expect(unusedNames).toContain('UNUSED_CONST');
      // Note: UnusedType may not be in unused if types are excluded
    });

    it('does not mark used exports as unused', () => {
      const unused = analyzer.findUnusedExports(analysis);
      const unusedNames = unused.map(u => u.export.name);

      expect(unusedNames).not.toContain('usedFunction');
      expect(unusedNames).not.toContain('UsedClass');
      expect(unusedNames).not.toContain('USED_CONST');
    });

    it('includes function signatures', () => {
      const utilsExports = analysis.files.get('src/utils.ts')?.exports;
      const usedFunc = utilsExports?.find(e => e.name === 'usedFunction');

      expect(usedFunc?.signature).toBeDefined();
      expect(usedFunc?.signature).toContain('string');
    });

    it('detects no circular dependencies', () => {
      expect(analysis.circularDependencies).toHaveLength(0);
    });
  });

  describe('circular dependencies', () => {
    let analysis: ProjectAnalysis;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'circular-deps');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('detects circular dependencies', () => {
      expect(analysis.circularDependencies.length).toBeGreaterThan(0);
    });

    it('identifies files in the cycle', () => {
      const cycle = analysis.circularDependencies[0];
      expect(cycle).toContain('src/a.ts');
      expect(cycle).toContain('src/b.ts');
    });
  });

  describe('path aliases', () => {
    let analysis: ProjectAnalysis;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'path-aliases');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('resolves path alias imports', () => {
      const indexImports = analysis.files.get('src/index.ts')?.imports;
      const buttonImport = indexImports?.find(i => i.name === 'Button');

      expect(buttonImport).toBeDefined();
      expect(buttonImport?.source).toBe('@components/Button');
      expect(buttonImport?.resolvedPath).toBe('src/components/Button.ts');
    });

    it('tracks usage through path aliases', () => {
      const buttonTrace = analysis.symbolTraces.get('src/components/Button.ts:Button');

      expect(buttonTrace).toBeDefined();
      expect(buttonTrace?.importedBy.length).toBeGreaterThan(0);
    });
  });

  describe('re-exports', () => {
    let analysis: ProjectAnalysis;
    let analyzer: ReturnType<typeof createAnalyzer>;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'reexports');
      analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('tracks named re-exports', () => {
      const indexExports = analysis.files.get('src/index.ts')?.exports;
      const internalFuncExport = indexExports?.find(e => e.name === 'internalFunc');

      expect(internalFuncExport).toBeDefined();
      expect(internalFuncExport?.isReExport).toBe(true);
      expect(internalFuncExport?.originalSource).toBe('src/internal.ts');
    });

    it('resolves kind for re-exports', () => {
      const indexExports = analysis.files.get('src/index.ts')?.exports;
      const internalFuncExport = indexExports?.find(e => e.name === 'internalFunc');

      expect(internalFuncExport?.kind).toBe('function');
    });

    it('tracks star re-exports', () => {
      const indexExports = analysis.files.get('src/index.ts')?.exports;
      const constExport = indexExports?.find(e => e.name === 'INTERNAL_CONST');

      expect(constExport).toBeDefined();
      expect(constExport?.isReExport).toBe(true);
    });

    it('does not mark re-exported originals as unused when re-export is used', () => {
      const unused = analyzer.findUnusedExports(analysis);
      const unusedNames = unused.map(u => u.export.name);

      // internalFunc is used via re-export
      expect(unusedNames).not.toContain('internalFunc');
    });
  });

  describe('getImpact', () => {
    let analysis: ProjectAnalysis;
    let analyzer: ReturnType<typeof createAnalyzer>;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('returns impacted files', () => {
      const impact = analyzer.getImpact(analysis, 'src/utils.ts');

      expect(impact).toContain('src/index.ts');
    });

    it('returns empty array for leaf files', () => {
      const impact = analyzer.getImpact(analysis, 'src/index.ts');

      expect(impact).toHaveLength(0);
    });
  });

  describe('compareExports', () => {
    it('detects removed exports', async () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      const oldAnalysis = await analyzer.analyze();

      // Create a "new" analysis with fewer exports by filtering
      const newAnalysis = { ...oldAnalysis };
      const newTraces = new Map(oldAnalysis.symbolTraces);
      newTraces.delete('src/utils.ts:unusedFunction');
      newAnalysis.symbolTraces = newTraces;

      const changes = analyzer.compareExports(oldAnalysis, newAnalysis);
      const removed = changes.filter(c => c.type === 'removed');

      expect(removed.length).toBeGreaterThan(0);
      expect(removed.some(c => c.export.name === 'unusedFunction')).toBe(true);
    });

    it('detects signature changes', async () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      const oldAnalysis = await analyzer.analyze();

      // Create a "new" analysis with changed signature
      const newAnalysis = { ...oldAnalysis };
      const newTraces = new Map(oldAnalysis.symbolTraces);

      // Get an existing trace and modify its signature
      const usedFuncKey = 'src/utils.ts:usedFunction';
      const oldTrace = newTraces.get(usedFuncKey);
      if (oldTrace) {
        const modifiedTrace = {
          ...oldTrace,
          symbol: {
            ...oldTrace.symbol,
            signature: '(a: number, b: string) => boolean', // different signature
          },
        };
        newTraces.set(usedFuncKey, modifiedTrace);
      }
      newAnalysis.symbolTraces = newTraces;

      const changes = analyzer.compareExports(oldAnalysis, newAnalysis);
      const signatureChanges = changes.filter(c => c.type === 'signature_changed');

      expect(signatureChanges.length).toBeGreaterThan(0);
      expect(signatureChanges.some(c => c.export.name === 'usedFunction')).toBe(true);
    });
  });

  describe('isEntryPoint', () => {
    it('identifies index files as entry points', () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });

      expect(analyzer.isEntryPoint('src/index.ts')).toBe(true);
      expect(analyzer.isEntryPoint('index.ts')).toBe(true);
    });

    it('identifies main files as entry points', () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });

      expect(analyzer.isEntryPoint('src/main.ts')).toBe(true);
      expect(analyzer.isEntryPoint('main.ts')).toBe(true);
    });

    it('does not identify regular files as entry points', () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });

      expect(analyzer.isEntryPoint('src/utils.ts')).toBe(false);
    });
  });

  describe('getSymbolTrace', () => {
    let analysis: ProjectAnalysis;
    let analyzer: ReturnType<typeof createAnalyzer>;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('returns trace for valid symbol', () => {
      const trace = analyzer.getSymbolTrace(analysis, 'src/utils.ts', 'usedFunction');

      expect(trace).toBeDefined();
      expect(trace?.symbol.name).toBe('usedFunction');
    });

    it('returns undefined for non-existent symbol', () => {
      const trace = analyzer.getSymbolTrace(analysis, 'src/utils.ts', 'nonExistent');

      expect(trace).toBeUndefined();
    });

    it('handles absolute paths', () => {
      const projectDir = path.join(FIXTURES_DIR, 'simple-project');
      const absolutePath = path.join(projectDir, 'src/utils.ts');
      const trace = analyzer.getSymbolTrace(analysis, absolutePath, 'usedFunction');

      expect(trace).toBeDefined();
      expect(trace?.symbol.name).toBe('usedFunction');
    });
  });

  describe('imported but unused detection', () => {
    let analysis: ProjectAnalysis;
    let analyzer: ReturnType<typeof createAnalyzer>;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'imported-unused');
      analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('detects symbols that are imported but not used', () => {
      const unused = analyzer.findUnusedExports(analysis);
      const unusedNames = unused.map(u => u.export.name);
      const unusedReasons = unused.map(u => u.reason);

      expect(unusedNames).toContain('importedButNotUsed');
      const importedButNotUsedUnused = unused.find(u => u.export.name === 'importedButNotUsed');
      expect(importedButNotUsedUnused?.reason).toContain('Imported by');
      expect(importedButNotUsedUnused?.reason).toContain('never actually used');
    });

    it('does not mark actually used symbols as unused', () => {
      const unused = analyzer.findUnusedExports(analysis);
      const unusedNames = unused.map(u => u.export.name);

      expect(unusedNames).not.toContain('actuallyUsed');
    });
  });

  describe('usage types', () => {
    let analysis: ProjectAnalysis;

    beforeAll(async () => {
      const projectDir = path.join(FIXTURES_DIR, 'usage-types');
      const analyzer = createAnalyzer(projectDir, undefined, { cache: false });
      analysis = await analyzer.analyze();
    });

    it('detects class extension usage', () => {
      const baseClassTrace = analysis.symbolTraces.get('src/base.ts:BaseClass');
      expect(baseClassTrace).toBeDefined();
      // BaseClass is used via extension
      expect(baseClassTrace?.usages.length).toBeGreaterThan(0);
    });

    it('detects interface usage', () => {
      const interfaceTrace = analysis.symbolTraces.get('src/base.ts:BaseInterface');
      expect(interfaceTrace).toBeDefined();
      // Interface may be used via implementation
      expect(interfaceTrace?.importedBy.length).toBeGreaterThan(0);
    });

    it('tracks function usages', () => {
      const createValueTrace = analysis.symbolTraces.get('src/base.ts:createValue');
      expect(createValueTrace).toBeDefined();
      // createValue is called
      expect(createValueTrace?.usageCount).toBeGreaterThan(0);
    });

    it('tracks all imported symbols', () => {
      const processValueTrace = analysis.symbolTraces.get('src/base.ts:processValue');
      expect(processValueTrace).toBeDefined();
      expect(processValueTrace?.importedBy.length).toBeGreaterThan(0);
    });
  });
});
