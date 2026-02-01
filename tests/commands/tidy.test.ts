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

// Mock inquirer
const mockPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: {
    prompt: mockPrompt,
  },
}));

// Mock config module
let mockHasApiKey = false;
let mockApiKey: string | undefined;
vi.mock('../../src/commands/config.js', () => ({
  hasGlobalApiKey: () => mockHasApiKey,
  getGlobalApiKey: () => mockApiKey,
}));

// Mock gemini client
const mockTidyCode = vi.fn();
vi.mock('../../src/core/gemini.js', () => ({
  createGeminiClient: () => ({
    tidyCode: mockTidyCode,
  }),
}));

const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalProcessExit = process.exit;

describe('tidyCommand', () => {
  let tempDir: string;
  let consoleLogs: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogs = [];
    exitCode = undefined;
    mockHasApiKey = true;
    mockApiKey = 'test-api-key';

    console.log = vi.fn((...args) => consoleLogs.push(args.join(' ')));
    console.error = vi.fn();
    process.exit = vi.fn((code) => {
      exitCode = code as number;
      throw new Error(`process.exit(${code})`);
    }) as never;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));

    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'test.ts'),
      `export function messy() {
  const x = 1;
  const y = 2;
  return x + y;
}`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails when no API key configured', async () => {
    mockHasApiKey = false;

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);

    try {
      await tidyCommand('src/test.ts', { skipVerify: true });
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    const output = consoleLogs.join('\n');
    expect(output).toContain('API key not configured');
  });

  it('fails when file not found', async () => {
    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);

    try {
      await tidyCommand('nonexistent.ts', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    const output = consoleLogs.join('\n');
    expect(output).toContain('File not found');
  });

  it('shows no changes when AI returns empty', async () => {
    mockTidyCode.mockResolvedValue({
      cleanedCode: '',
      changes: [],
      reasoning: '',
    });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No changes suggested');
  });

  it('shows suggested changes', async () => {
    mockTidyCode.mockResolvedValue({
      cleanedCode: `export function clean() {
  return 1 + 2;
}`,
      changes: ['Simplified function', 'Removed unused variables'],
      reasoning: 'Code was simplified for clarity',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Suggested Changes');
    expect(output).toContain('Simplified function');
    expect(output).toContain('Reasoning');
  });

  it('applies changes with --apply flag', async () => {
    const cleanCode = `export function clean() { return 3; }`;
    mockTidyCode.mockResolvedValue({
      cleanedCode: cleanCode,
      changes: ['Simplified'],
      reasoning: 'Test',
    });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { apply: true, skipVerify: true });

    const content = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    expect(content).toBe(cleanCode);
    const output = consoleLogs.join('\n');
    expect(output).toContain('Changes applied');
  });

  it('does not change file with --dryRun flag', async () => {
    const originalContent = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    mockTidyCode.mockResolvedValue({
      cleanedCode: 'changed code',
      changes: ['Changed'],
      reasoning: 'Test',
    });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { dryRun: true, skipVerify: true });

    const content = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    expect(content).toBe(originalContent);
    const output = consoleLogs.join('\n');
    expect(output).toContain('Dry run');
  });

  it('saves to .suggested file when user chooses save', async () => {
    mockTidyCode.mockResolvedValue({
      cleanedCode: 'saved code',
      changes: ['Changed'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'save' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    expect(fs.existsSync(path.join(tempDir, 'src', 'test.ts.suggested'))).toBe(true);
  });

  it('discards changes when user chooses discard', async () => {
    const originalContent = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    mockTidyCode.mockResolvedValue({
      cleanedCode: 'discarded code',
      changes: ['Changed'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const content = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    expect(content).toBe(originalContent);
  });

  it('shows diff with added lines', async () => {
    mockTidyCode.mockResolvedValue({
      cleanedCode: `export function clean() {
  return 1 + 2;
}
// New line added
// Another new line`,
      changes: ['Added comments'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const output = consoleLogs.join('\n');
    expect(output).toContain('Preview');
  });

  it('shows diff with removed lines', async () => {
    // File with many lines
    fs.writeFileSync(
      path.join(tempDir, 'src', 'multiline.ts'),
      `line1
line2
line3
line4
line5`
    );

    mockTidyCode.mockResolvedValue({
      cleanedCode: `line1
line3`,
      changes: ['Removed lines'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/multiline.ts', { skipVerify: true });

    expect(mockOra.succeed).toHaveBeenCalled();
  });

  it('truncates diff when more than 20 changes', async () => {
    // Create file with many lines
    const manyLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    fs.writeFileSync(path.join(tempDir, 'src', 'manylines.ts'), manyLines);

    // Return completely different content
    const differentLines = Array.from({ length: 30 }, (_, i) => `changed${i}`).join('\n');
    mockTidyCode.mockResolvedValue({
      cleanedCode: differentLines,
      changes: ['Many changes'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/manylines.ts', { skipVerify: true });

    const output = consoleLogs.join('\n');
    expect(output).toContain('... and more changes');
  });

  it('shows no visible changes when content is identical', async () => {
    const originalContent = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    mockTidyCode.mockResolvedValue({
      cleanedCode: originalContent,
      changes: ['Formatting only'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'discard' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const output = consoleLogs.join('\n');
    expect(output).toContain('No visible changes');
  });

  it('applies changes when user chooses apply', async () => {
    const cleanCode = `export function applied() { return 'applied'; }`;
    mockTidyCode.mockResolvedValue({
      cleanedCode: cleanCode,
      changes: ['Applied'],
      reasoning: 'Test',
    });
    mockPrompt.mockResolvedValue({ action: 'apply' });

    const { tidyCommand } = await import('../../src/commands/tidy.js');

    process.chdir(tempDir);
    await tidyCommand('src/test.ts', { skipVerify: true });

    const content = fs.readFileSync(path.join(tempDir, 'src', 'test.ts'), 'utf-8');
    expect(content).toBe(cleanCode);
  });
});
