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

// Mock inquirer
const mockPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: {
    prompt: mockPrompt,
  },
}));

// Mock hasGlobalApiKey
vi.mock('../../src/commands/config.js', () => ({
  hasGlobalApiKey: vi.fn(() => false),
}));

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

describe('initCommand', () => {
  let tempDir: string;
  let consoleLogs: string[];
  let exitCode: number | undefined;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs = [];
    exitCode = undefined;

    // Mock TTY to enable interactive mode
    originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });

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
export function main() { return helper(); }
export class MyClass {}`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helper.ts'),
      `export function helper(): string { return 'hello'; }
export type HelperType = string;`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, writable: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('analyzes and shows summary', async () => {
    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('Project Summary');
    expect(output).toContain('Files analyzed');
    expect(output).toContain('Total exports');
  });

  it('shows action menu after analysis', async () => {
    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    expect(mockPrompt).toHaveBeenCalled();
  });

  it('handles exports action', async () => {
    mockPrompt.mockResolvedValue({ action: 'exports' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('consuela exports');
  });

  it('handles trace action', async () => {
    mockPrompt
      .mockResolvedValueOnce({ action: 'trace' })
      .mockResolvedValueOnce({ symbol: 'back' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    // Should have prompted for symbol selection
    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('handles unused action', async () => {
    mockPrompt.mockResolvedValue({ action: 'unused' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('consuela fix');
  });

  it('handles impact action', async () => {
    mockPrompt
      .mockResolvedValueOnce({ action: 'impact' })
      .mockResolvedValueOnce({ file: 'back' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    expect(mockPrompt).toHaveBeenCalledTimes(2);
  });

  it('shows circular dependencies when present', async () => {
    // Create circular dependency
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `import { b } from './b.js';\nexport const a = () => b();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `import { a } from './a.js';\nexport const b = () => a();`
    );

    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('circular dependencies');
  });

  it('shows unused exports when present', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'unused.ts'),
      `export function neverUsed() { return 'unused'; }`
    );

    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('unused exports');
  });

  it('shows most depended-on files', async () => {
    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('Most Depended-On');
  });

  it('shows most used exports', async () => {
    mockPrompt.mockResolvedValue({ action: 'exit' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('Most Used Exports');
  });

  it('handles tidy action', async () => {
    mockPrompt.mockResolvedValue({ action: 'tidy' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('consuela fix --deep');
  });

  it('shows command when trace symbol is selected', async () => {
    mockPrompt
      .mockResolvedValueOnce({ action: 'trace' })
      .mockResolvedValueOnce({ symbol: 'src/helper.ts:helper' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('consuela trace');
  });

  it('shows command when impact file is selected', async () => {
    mockPrompt
      .mockResolvedValueOnce({ action: 'impact' })
      .mockResolvedValueOnce({ file: 'src/helper.ts' });

    const { initCommand } = await import('../../src/commands/init.js');

    process.chdir(tempDir);
    await initCommand();

    const output = consoleLogs.join('\n');
    expect(output).toContain('consuela impact');
  });
});
