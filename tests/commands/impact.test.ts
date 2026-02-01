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

describe('impactCommand', () => {
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
      `export function helper(): string { return 'hello'; }`
    );
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('analyzes impact of a file', async () => {
    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', {});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('Impact Analysis');
    expect(output).toContain('helper.ts');
    expect(output).toContain('index.ts');
  });

  it('outputs JSON when --json flag is set', async () => {
    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', { json: true });

    const jsonOutput = consoleLogs.find((log) => log.includes('"file"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.file).toContain('helper.ts');
    expect(parsed.directDependents).toContain('src/index.ts');
  });

  it('handles file not found', async () => {
    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);

    try {
      await impactCommand('src/nonexistent.ts', {});
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
    const output = consoleLogs.join('\n');
    expect(output).toContain('File not found');
  });

  it('shows risk assessment for high impact files', async () => {
    // Create many dependent files
    for (let i = 0; i < 15; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `consumer${i}.ts`),
        `import { helper } from './helper.js';
export const use${i} = () => helper();`
      );
    }

    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('HIGH RISK');
  });

  it('shows low risk for leaf files', async () => {
    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/index.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('LOW RISK');
  });

  it('shows transitive impact', async () => {
    // Create a chain: helper -> middle -> consumer
    fs.writeFileSync(
      path.join(tempDir, 'src', 'middle.ts'),
      `import { helper } from './helper.js';
export function middle() { return helper(); }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'consumer.ts'),
      `import { middle } from './middle.js';
export function consumer() { return middle(); }`
    );

    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('middle.ts');
  });

  it('shows medium risk for 4-10 impacted files', async () => {
    // Create 5 dependent files for medium risk
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `dep${i}.ts`),
        `import { helper } from './helper.js';
export const use${i} = () => helper();`
      );
    }

    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('MEDIUM RISK');
  });

  it('shows file with no exports', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'src', 'noexports.ts'),
      `const internal = 'hello';`
    );

    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/noexports.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('No exports');
  });

  it('truncates transitive impact list when more than 10', async () => {
    // Create many dependent files to trigger truncation
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `layer1_${i}.ts`),
        `import { helper } from './helper.js';
export const l1_${i} = () => helper();`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', `layer2_${i}.ts`),
        `import { l1_${i} } from './layer1_${i}.js';
export const l2_${i} = () => l1_${i}();`
      );
    }

    const { impactCommand } = await import('../../src/commands/impact.js');

    process.chdir(tempDir);
    await impactCommand('src/helper.ts', {});

    const output = consoleLogs.join('\n');
    expect(output).toContain('... and');
  });
});
