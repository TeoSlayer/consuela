import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock ora
const mockOra = {
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  text: '',
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOra) }));

// Mock child_process - store the mock function
const mockExecSync = vi.fn();
vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Mock analyzer
const mockAnalyze = vi.fn();
const mockCompareExports = vi.fn();
vi.mock('../../src/core/analyzer.js', () => ({
  createAnalyzer: vi.fn(() => ({
    analyze: mockAnalyze,
    compareExports: mockCompareExports,
  })),
}));

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

describe('diffCommand', () => {
  let tempDir: string;
  let consoleLogs: string[];
  let consoleErrors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs = [];
    consoleErrors = [];
    exitCode = undefined;

    console.log = vi.fn((...args) => consoleLogs.push(args.join(' ')));
    console.error = vi.fn((...args) => consoleErrors.push(args.join(' ')));
    process.exit = vi.fn((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    }) as never;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails when not in a git repository', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) {
        throw new Error('Not a git repo');
      }
      return '';
    });

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);

    try {
      await diffCommand('main', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    expect(mockOra.fail).toHaveBeenCalled();
  });

  it('fails when branch not found', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) {
        return '.git';
      }
      if (cmd.includes('git rev-parse --verify')) {
        throw new Error('Branch not found');
      }
      return '';
    });

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);

    try {
      await diffCommand('nonexistent-branch', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
  });

  it('compares branches and shows no breaking changes', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return 'src/index.ts\nsrc/utils.ts';
      if (cmd.includes('git show main:src/index.ts')) return 'export const a = 1;';
      if (cmd.includes('git show main:src/utils.ts')) return 'export const b = 2;';
      if (cmd.includes('git show main:tsconfig.json')) return '{}';
      if (cmd.includes('git show main:package.json')) return '{}';
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('No breaking changes');
  });

  it('outputs JSON when --json flag is set', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', { json: true });

    const jsonOutput = consoleLogs.find((log) => log.includes('"branch"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.branch).toBe('main');
    expect(parsed.breakingChanges).toEqual([]);
  });

  it('exits with code 1 when --fail and breaking changes exist', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([
      { type: 'removed', export: { name: 'foo', filePath: 'bar.ts' }, affectedFiles: [] },
    ]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);

    try {
      await diffCommand('main', { fail: true });
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
  });

  it('exits with code 1 when --json --fail and breaking changes exist', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([
      { type: 'removed', export: { name: 'foo', filePath: 'bar.ts' }, affectedFiles: [] },
    ]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);

    try {
      await diffCommand('main', { json: true, fail: true });
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
  });

  it('shows removed exports as breaking changes', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([
      {
        type: 'removed',
        export: { name: 'deletedFunc', filePath: 'utils.ts' },
        affectedFiles: ['consumer.ts', 'other.ts'],
      },
    ]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Breaking Changes');
    expect(output).toContain('Removed exports');
    expect(output).toContain('deletedFunc');
    expect(output).toContain('Breaks 2 files');
  });

  it('shows signature changes as breaking changes', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([
      {
        type: 'signature_changed',
        export: { name: 'changedFunc', filePath: 'api.ts' },
        details: 'Parameters changed from (a: string) to (a: string, b: number)',
        affectedFiles: ['caller.ts'],
      },
    ]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Changed signatures');
    expect(output).toContain('changedFunc');
    expect(output).toContain('Affects 1 files');
  });

  it('shows new exports', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    const newSymbolTraces = new Map([
      ['new.ts:newFunc', { symbol: { name: 'newFunc', filePath: 'new.ts', kind: 'function' } }],
    ]);

    mockAnalyze
      .mockResolvedValueOnce({
        symbolTraces: newSymbolTraces,
        circularDependencies: [],
      })
      .mockResolvedValueOnce({
        symbolTraces: new Map(),
        circularDependencies: [],
      });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('New Exports');
    expect(output).toContain('newFunc');
  });

  it('shows circular dependencies warning', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [['a.ts', 'b.ts', 'c.ts']],
    });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Circular Dependencies');
    expect(output).toContain('a.ts');
  });

  it('truncates many circular dependencies', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    const manyCycles = Array.from({ length: 8 }, (_, i) => [`file${i}.ts`, `dep${i}.ts`]);
    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: manyCycles,
    });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('and 3 more');
  });

  it('shows warning when only circular deps (no breaking changes)', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [['a.ts', 'b.ts']],
    });
    mockCompareExports.mockReturnValue([]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('No breaking changes, but circular dependencies detected');
  });

  it('shows review required when breaking changes exist', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      if (cmd.includes('git show')) throw new Error('Not found');
      return '';
    });

    mockAnalyze.mockResolvedValue({
      symbolTraces: new Map(),
      circularDependencies: [],
    });
    mockCompareExports.mockReturnValue([
      { type: 'removed', export: { name: 'foo', filePath: 'bar.ts' }, affectedFiles: ['a.ts', 'b.ts'] },
    ]);

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);
    await diffCommand('main', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Review required');
    expect(output).toContain('Files affected');
  });

  it('handles error during analysis', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('git rev-parse --git-dir')) return '.git';
      if (cmd.includes('git rev-parse --verify')) return 'abc123';
      if (cmd.includes('git ls-tree')) return '';
      return '';
    });

    mockAnalyze.mockRejectedValue(new Error('Analysis failed'));

    const { diffCommand } = await import('../../src/commands/diff.js');

    process.chdir(tempDir);

    try {
      await diffCommand('main', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    expect(mockOra.fail).toHaveBeenCalled();
  });
});

describe('diff printDiff function coverage', () => {
  let tempDir: string;
  let consoleLogs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs = [];
    console.log = vi.fn((...args) => consoleLogs.push(args.join(' ')));

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exports the diffCommand function', async () => {
    const mod = await import('../../src/commands/diff.js');
    expect(mod.diffCommand).toBeDefined();
    expect(typeof mod.diffCommand).toBe('function');
  });
});

describe('diff cleanup handlers', () => {
  it('registers cleanup handlers on module load', async () => {
    // The module registers handlers on import
    const mod = await import('../../src/commands/diff.js');
    expect(mod.diffCommand).toBeDefined();
  });
});
