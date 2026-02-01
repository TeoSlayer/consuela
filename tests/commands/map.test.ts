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

describe('mapCommand', () => {
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
      `import { helper } from './helper.js';
export function main() { return helper(); }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helper.ts'),
      `export function helper(): string { return 'hello'; }
export function unused() { return 'unused'; }`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('outputs codebase map', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('Codebase Map');
    expect(output).toContain('Files:');
    expect(output).toContain('Exports:');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ json: true });

    const jsonOutput = consoleLogs.find((log) => log.includes('"summary"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.totalFiles).toBeGreaterThan(0);
    expect(parsed.files).toBeDefined();
    expect(parsed.dependencyGraph).toBeDefined();
  });

  it('focuses on specific file when --file is set', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ file: 'src/helper.ts' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Focus:');
    expect(output).toContain('helper.ts');
  });

  it('respects depth option', async () => {
    // Create deeper dependency chain
    fs.writeFileSync(
      path.join(tempDir, 'src', 'deep.ts'),
      `import { main } from './index.js';
export const deep = () => main();`
    );

    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ json: true, depth: '1' });

    expect(mockOra.succeed).toHaveBeenCalled();
  });

  it('shows most connected files', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Key Files');
  });

  it('shows most used exports', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Most Used Exports');
  });

  it('focuses on file with JSON output including related files', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ json: true, file: 'src/helper.ts' });

    const jsonOutput = consoleLogs.find((log) => log.includes('"summary"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  it('handles files with no imports or exports', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'empty.ts'),
      `const internal = 'not exported';`
    );

    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ file: 'src/empty.ts' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('(none)');
  });

  it('shows focused file details with imports and dependents', async () => {
    const { mapCommand } = await import('../../src/commands/map.js');

    process.chdir(tempDir);
    await mapCommand({ file: 'src/index.ts' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Focus:');
    expect(output).toContain('Imports from:');
  });
});
