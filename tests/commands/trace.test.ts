import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock ora
const mockOra = {
  start: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({ default: vi.fn(() => mockOra) }));

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

describe('traceCommand', () => {
  let tempDir: string;
  let consoleLogs: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs = [];
    exitCode = undefined;

    console.log = vi.fn((...args) => consoleLogs.push(args.join(' ')));
    console.error = vi.fn();
    process.exit = vi.fn((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    }) as never;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));

    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      `import { myFunc } from './utils.js';
export function main() { return myFunc(); }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'utils.ts'),
      `export function myFunc(): string { return 'hello'; }`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('traces a symbol by name', async () => {
    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', {});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('myFunc');
    expect(output).toContain('utils.ts');
  });

  it('traces a symbol by full path', async () => {
    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('src/utils.ts:myFunc', {});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('myFunc');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', { json: true });

    const jsonOutput = consoleLogs.find((log) => log.includes('"symbol"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.symbol.name).toBe('myFunc');
  });

  it('handles symbol not found', async () => {
    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);

    try {
      await traceCommand('nonExistentFunc', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    const output = consoleLogs.join('\n');
    expect(output).toContain('No export found');
  });

  it('handles multiple symbols with same name', async () => {
    // Create another file with same export name
    fs.writeFileSync(
      path.join(tempDir, 'src', 'other.ts'),
      `export function myFunc() { return 'other'; }`
    );

    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);

    try {
      await traceCommand('myFunc', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    const output = consoleLogs.join('\n');
    expect(output).toContain('Multiple exports found');
  });

  it('shows imported by and usages information', async () => {
    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Imported by');
    expect(output).toContain('Usages');
    expect(output).toContain('index.ts');
  });

  it('shows unused warning for symbols with no usages', async () => {
    // Create unused export
    fs.writeFileSync(
      path.join(tempDir, 'src', 'unused.ts'),
      `export function neverUsed() { return 'unused'; }`
    );

    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('neverUsed', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('unused');
  });

  it('shows high impact warning for symbols with many dependents', async () => {
    // Create many dependent files
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `consumer${i}.ts`),
        `import { myFunc } from './utils.js';
export const use${i} = () => myFunc();`
      );
    }

    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('High impact');
  });

  it('truncates long dependents list', async () => {
    // Create more than 10 dependent files
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `dep${i}.ts`),
        `import { myFunc } from './utils.js';
export const d${i} = () => myFunc();`
      );
    }

    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('... and');
    expect(output).toContain('more files');
  });

  it('truncates many usages per file', async () => {
    // Create a file with many usages of myFunc
    fs.writeFileSync(
      path.join(tempDir, 'src', 'manyuses.ts'),
      `import { myFunc } from './utils.js';
const a = myFunc();
const b = myFunc();
const c = myFunc();
const d = myFunc();
const e = myFunc();
const f = myFunc();
const g = myFunc();
export const result = a + b + c + d + e + f + g;`
    );

    const { traceCommand } = await import('../../src/commands/trace.js');

    process.chdir(tempDir);
    await traceCommand('myFunc', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('more usages');
  });
});
