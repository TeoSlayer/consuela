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

// Mock console and process.exit
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

describe('unusedCommand', () => {
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

    // Create temp directory with test files
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));

    // Create a simple project structure
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      `import { usedFunc } from './utils.js';
export function main() { return usedFunc(); }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'utils.ts'),
      `export function usedFunc() { return 1; }
export function unusedFunc() { return 2; }`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds unused exports', async () => {
    // Import the module inside the test after mocks are set up
    const { unusedCommand } = await import('../../src/commands/unused.js');

    process.chdir(tempDir);
    await unusedCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    // Check that output contains something about unused
    const output = consoleLogs.join('\n');
    expect(output).toContain('unusedFunc');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { unusedCommand } = await import('../../src/commands/unused.js');

    process.chdir(tempDir);
    await unusedCommand({ json: true });

    // Find the JSON output
    const jsonOutput = consoleLogs.find((log) => log.startsWith('['));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('exits with code 1 when --fail flag is set and unused found', async () => {
    const { unusedCommand } = await import('../../src/commands/unused.js');

    process.chdir(tempDir);

    try {
      await unusedCommand({ fail: true });
    } catch (e) {
      // Expected to throw due to process.exit mock
    }

    expect(exitCode).toBe(1);
  });

  it('shows entry points with --strict flag', async () => {
    // Create an entry point file
    fs.writeFileSync(
      path.join(tempDir, 'src', 'main.ts'),
      `export function mainExport() { return 'main'; }`
    );

    const { unusedCommand } = await import('../../src/commands/unused.js');

    process.chdir(tempDir);
    await unusedCommand({ strict: true });

    expect(mockOra.succeed).toHaveBeenCalled();
  });

  it('handles no unused exports found', async () => {
    // Create a project where everything is used
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      `import { usedFunc } from './utils.js';
export const result = usedFunc();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'utils.ts'),
      `export function usedFunc() { return 1; }`
    );

    const { unusedCommand } = await import('../../src/commands/unused.js');

    process.chdir(tempDir);
    await unusedCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
  });
});
