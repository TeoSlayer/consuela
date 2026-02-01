import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createConfiguredAnalyzer } from '../../src/core/index.js';

describe('createConfiguredAnalyzer', () => {
  let tempDir: string;
  const originalCwd = process.cwd();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));
    process.chdir(tempDir);

    // Create minimal project structure
    fs.mkdirSync(path.join(tempDir, 'src'));
    fs.writeFileSync(
      path.join(tempDir, 'src', 'index.ts'),
      'export const hello = "world";'
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates analyzer with default cwd', async () => {
    const analyzer = createConfiguredAnalyzer();
    expect(analyzer).toBeDefined();

    const analysis = await analyzer.analyze();
    expect(analysis.files.size).toBeGreaterThan(0);
  });

  it('creates analyzer with specified root dir', async () => {
    const analyzer = createConfiguredAnalyzer(tempDir);
    expect(analyzer).toBeDefined();
  });

  it('loads config from project', async () => {
    // Write a config file
    fs.writeFileSync(
      path.join(tempDir, '.consuelarc'),
      JSON.stringify({ ignore: ['**/*.test.ts'] })
    );

    const analyzer = createConfiguredAnalyzer(tempDir);
    expect(analyzer).toBeDefined();
  });
});
