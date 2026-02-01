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

describe('exportsCommand', () => {
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
      `export function myFunc(): string { return 'hello'; }
export class MyClass {}
export const MY_CONST = 42;
export type MyType = string;`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists all exports', async () => {
    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('myFunc');
    expect(output).toContain('MyClass');
    expect(output).toContain('MY_CONST');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({ json: true });

    const jsonOutput = consoleLogs.find((log) => log.startsWith('['));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((e: any) => e.name === 'myFunc')).toBe(true);
  });

  it('filters by file when --file flag is set', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'other.ts'),
      `export function otherFunc() { return 'other'; }`
    );

    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({ file: 'index' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('myFunc');
    expect(output).not.toContain('otherFunc');
  });

  it('filters by kind when --kind flag is set', async () => {
    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({ kind: 'function' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('myFunc');
    expect(output).not.toContain('MyClass');
  });

  it('handles no exports matching criteria', async () => {
    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({ kind: 'enum' });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No exports found matching criteria');
  });

  it('shows summary with kind breakdown', async () => {
    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Total:');
    expect(output).toContain('function:');
  });

  it('displays interface exports with correct color', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'types.ts'),
      `export interface MyInterface { name: string; }`
    );

    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('MyInterface');
    expect(output).toContain('interface');
  });

  it('displays enum exports with correct color', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'enums.ts'),
      `export enum Status { Active, Inactive }`
    );

    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Status');
    expect(output).toContain('enum');
  });

  it('displays variable exports with correct color', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'vars.ts'),
      `export let myVariable = 42;`
    );

    const { exportsCommand } = await import('../../src/commands/exports.js');

    process.chdir(tempDir);
    await exportsCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('myVariable');
  });
});
