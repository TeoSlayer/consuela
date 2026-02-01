import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadProjectConfig, mergeWithDefaults } from '../../src/core/config.js';

describe('Config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consuela-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadProjectConfig', () => {
    it('returns empty config when no config file exists', () => {
      const config = loadProjectConfig(tempDir);
      expect(config).toEqual({});
    });

    it('loads .consuelarc file', () => {
      const configContent = {
        ignore: ['**/*.test.ts'],
        entryPoints: ['src/main.ts'],
      };
      fs.writeFileSync(
        path.join(tempDir, '.consuelarc'),
        JSON.stringify(configContent)
      );

      const config = loadProjectConfig(tempDir);
      expect(config).toEqual(configContent);
    });

    it('loads .consuelarc.json file', () => {
      const configContent = {
        ignore: ['tests/**'],
        noCache: true,
      };
      fs.writeFileSync(
        path.join(tempDir, '.consuelarc.json'),
        JSON.stringify(configContent)
      );

      const config = loadProjectConfig(tempDir);
      expect(config).toEqual(configContent);
    });

    it('loads consuela.config.json file', () => {
      const configContent = {
        entryPoints: ['lib/index.ts'],
      };
      fs.writeFileSync(
        path.join(tempDir, 'consuela.config.json'),
        JSON.stringify(configContent)
      );

      const config = loadProjectConfig(tempDir);
      expect(config).toEqual(configContent);
    });

    it('loads config from package.json consuela key', () => {
      const packageContent = {
        name: 'test-package',
        consuela: {
          ignore: ['dist/**'],
          entryPoints: ['src/cli.ts'],
        },
      };
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify(packageContent)
      );

      const config = loadProjectConfig(tempDir);
      expect(config).toEqual(packageContent.consuela);
    });

    it('prefers .consuelarc over package.json', () => {
      const rcContent = { ignore: ['from-rc'] };
      const packageContent = {
        name: 'test',
        consuela: { ignore: ['from-package'] },
      };

      fs.writeFileSync(
        path.join(tempDir, '.consuelarc'),
        JSON.stringify(rcContent)
      );
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify(packageContent)
      );

      const config = loadProjectConfig(tempDir);
      expect(config.ignore).toEqual(['from-rc']);
    });

    it('handles invalid JSON gracefully', () => {
      fs.writeFileSync(path.join(tempDir, '.consuelarc'), 'not valid json');

      // Should not throw, returns empty config
      const config = loadProjectConfig(tempDir);
      expect(config).toEqual({});
    });

    it('handles invalid package.json gracefully', () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), 'not valid json');

      const config = loadProjectConfig(tempDir);
      expect(config).toEqual({});
    });
  });

  describe('mergeWithDefaults', () => {
    it('returns defaults when config is empty', () => {
      const result = mergeWithDefaults({});

      expect(result.ignore).toEqual([]);
      expect(result.entryPoints).toEqual([]);
      expect(result.cache).toBe(true);
    });

    it('uses provided ignore patterns', () => {
      const result = mergeWithDefaults({ ignore: ['**/*.test.ts'] });

      expect(result.ignore).toEqual(['**/*.test.ts']);
    });

    it('uses provided entry points', () => {
      const result = mergeWithDefaults({ entryPoints: ['src/main.ts'] });

      expect(result.entryPoints).toEqual(['src/main.ts']);
    });

    it('disables cache when noCache is true', () => {
      const result = mergeWithDefaults({ noCache: true });

      expect(result.cache).toBe(false);
    });

    it('enables cache when noCache is false', () => {
      const result = mergeWithDefaults({ noCache: false });

      expect(result.cache).toBe(true);
    });

    it('enables cache when noCache is undefined', () => {
      const result = mergeWithDefaults({});

      expect(result.cache).toBe(true);
    });
  });
});
