import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ConsuelaConfig {
  // Patterns to ignore (added to defaults)
  ignore?: string[];

  // Custom entry point patterns
  entryPoints?: string[];

  // Disable caching
  noCache?: boolean;

  // Files/exports to exclude from unused detection
  excludeFromUnused?: string[];
}

const CONFIG_FILES = ['.consuelarc', '.consuelarc.json', 'consuela.config.json'];

export function loadProjectConfig(rootDir: string): ConsuelaConfig {
  for (const configFile of CONFIG_FILES) {
    const configPath = path.join(rootDir, configFile);
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        console.warn(`Warning: Failed to parse ${configFile}: ${error}`);
      }
    }
  }

  // Also check package.json for "consuela" key
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.consuela) {
        return pkg.consuela;
      }
    } catch {
      // Ignore
    }
  }

  return {};
}

export function mergeWithDefaults(config: ConsuelaConfig): {
  ignore: string[];
  entryPoints: string[];
  cache: boolean;
} {
  return {
    ignore: config.ignore || [],
    entryPoints: config.entryPoints || [],
    cache: !config.noCache,
  };
}
