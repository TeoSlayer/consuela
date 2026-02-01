import { describe, it, expect } from 'vitest';

describe('commands/index.ts exports', () => {
  it('exports all command functions', async () => {
    const commands = await import('../../src/commands/index.js');

    expect(commands.configCommand).toBeDefined();
    expect(commands.getGlobalApiKey).toBeDefined();
    expect(commands.hasGlobalApiKey).toBeDefined();
    expect(commands.initCommand).toBeDefined();
    expect(commands.exportsCommand).toBeDefined();
    expect(commands.traceCommand).toBeDefined();
    expect(commands.unusedCommand).toBeDefined();
    expect(commands.impactCommand).toBeDefined();
    expect(commands.diffCommand).toBeDefined();
    expect(commands.tidyCommand).toBeDefined();
    expect(commands.circularCommand).toBeDefined();
    expect(commands.mapCommand).toBeDefined();
  });

  it('all exports are functions', async () => {
    const commands = await import('../../src/commands/index.js');

    expect(typeof commands.configCommand).toBe('function');
    expect(typeof commands.getGlobalApiKey).toBe('function');
    expect(typeof commands.hasGlobalApiKey).toBe('function');
    expect(typeof commands.initCommand).toBe('function');
    expect(typeof commands.exportsCommand).toBe('function');
    expect(typeof commands.traceCommand).toBe('function');
    expect(typeof commands.unusedCommand).toBe('function');
    expect(typeof commands.impactCommand).toBe('function');
    expect(typeof commands.diffCommand).toBe('function');
    expect(typeof commands.tidyCommand).toBe('function');
    expect(typeof commands.circularCommand).toBe('function');
    expect(typeof commands.mapCommand).toBe('function');
  });
});
