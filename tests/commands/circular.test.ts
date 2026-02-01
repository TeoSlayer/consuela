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

describe('circularCommand', () => {
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
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    process.exit = originalProcessExit;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports no circular dependencies when none exist', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      `import { helper } from './helper.js';
export function main() { return helper(); }`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'helper.ts'),
      `export function helper() { return 1; }`
    );

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('No circular dependencies found');
  });

  it('detects circular dependencies', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `import { b } from './b.js';
export const a = () => b();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `import { a } from './a.js';
export const b = () => a();`
    );

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('circular dependency');
  });

  it('outputs JSON when --json flag is set', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `import { b } from './b.js';
export const a = () => b();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `import { a } from './a.js';
export const b = () => a();`
    );

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({ json: true });

    const jsonOutput = consoleLogs.find((log) => log.includes('"count"'));
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput!);
    expect(parsed.count).toBeGreaterThan(0);
  });

  it('exits with code 1 when --fail flag is set and cycles found', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `import { b } from './b.js';
export const a = () => b();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `import { a } from './a.js';
export const b = () => a();`
    );

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);

    try {
      await circularCommand({ fail: true });
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
  });

  it('handles medium and large cycles', async () => {
    // Create a 4-file cycle
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), `import { b } from './b.js';\nexport const a = 1;`);
    fs.writeFileSync(path.join(tempDir, 'src', 'b.ts'), `import { c } from './c.js';\nexport const b = 2;`);
    fs.writeFileSync(path.join(tempDir, 'src', 'c.ts'), `import { d } from './d.js';\nexport const c = 3;`);
    fs.writeFileSync(path.join(tempDir, 'src', 'd.ts'), `import { a } from './a.js';\nexport const d = 4;`);

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('Medium cycles');
  });

  it('identifies hotspots in multiple cycles', async () => {
    // Create a file that appears in multiple cycles
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(path.join(tempDir, 'src', 'hub.ts'), `import { a } from './a.js';\nimport { b } from './b.js';\nexport const hub = 1;`);
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), `import { hub } from './hub.js';\nexport const a = 2;`);
    fs.writeFileSync(path.join(tempDir, 'src', 'b.ts'), `import { hub } from './hub.js';\nexport const b = 3;`);

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    expect(mockOra.succeed).toHaveBeenCalled();
  });

  it('exits with code 1 with --fail and --json when cycles exist', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'a.ts'),
      `import { b } from './b.js';\nexport const a = () => b();`
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'b.ts'),
      `import { a } from './a.js';\nexport const b = () => a();`
    );

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);

    try {
      await circularCommand({ json: true, fail: true });
    } catch (e) {
      // Expected
    }

    expect(exitCode).toBe(1);
  });

  it('handles large cycles (6+ files)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // Create a 7-file cycle: a -> b -> c -> d -> e -> f -> g -> a
    for (let i = 0; i < 7; i++) {
      const letter = String.fromCharCode(97 + i); // a, b, c, d, e, f, g
      const nextLetter = String.fromCharCode(97 + ((i + 1) % 7));
      fs.writeFileSync(
        path.join(tempDir, 'src', `${letter}.ts`),
        `import { ${nextLetter} } from './${nextLetter}.js';\nexport const ${letter} = ${i};`
      );
    }

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Large cycles');
  });

  it('truncates many small cycles (> 10)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // Create 12 separate 2-file cycles
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `pair${i}a.ts`),
        `import { b${i} } from './pair${i}b.js';\nexport const a${i} = 1;`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', `pair${i}b.ts`),
        `import { a${i} } from './pair${i}a.js';\nexport const b${i} = 2;`
      );
    }

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('... and');
    expect(output).toContain('more');
  });

  it('truncates many medium cycles (> 5)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // Create 7 separate 4-file cycles (medium = 3-5 files)
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(
        path.join(tempDir, 'src', `med${i}a.ts`),
        `import { b${i} } from './med${i}b.js';\nexport const a${i} = 1;`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', `med${i}b.ts`),
        `import { c${i} } from './med${i}c.js';\nexport const b${i} = 2;`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', `med${i}c.ts`),
        `import { d${i} } from './med${i}d.js';\nexport const c${i} = 3;`
      );
      fs.writeFileSync(
        path.join(tempDir, 'src', `med${i}d.ts`),
        `import { a${i} } from './med${i}a.js';\nexport const d${i} = 4;`
      );
    }

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Medium cycles');
    expect(output).toContain('... and');
  });

  it('truncates many large cycles (> 3)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'));
    // Create 5 separate 7-file cycles (large = 6+ files)
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 7; j++) {
        const nextJ = (j + 1) % 7;
        fs.writeFileSync(
          path.join(tempDir, 'src', `large${i}_${j}.ts`),
          `import { x${nextJ} } from './large${i}_${nextJ}.js';\nexport const x${j} = ${j};`
        );
      }
    }

    const { circularCommand } = await import('../../src/commands/circular.js');

    process.chdir(tempDir);
    await circularCommand({});

    const output = consoleLogs.join('\n');
    expect(output).toContain('Large cycles');
    expect(output).toContain('... and');
  });
});
