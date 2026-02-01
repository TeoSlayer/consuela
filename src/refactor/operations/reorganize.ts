/**
 * reorganize operations - Transform a messy codebase into a well-organized project
 *
 * Uses AI to suggest domain-based organization, handles import updates,
 * and provides safe execution with rollback support.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { ProjectAnalyzer, type ProjectAnalysis, type ExportInfo } from '../../core/analyzer.js';
import { GraphAnalyzer } from '../../graph/analyzer.js';
import {
  createGeminiClient,
  type FileInfoForReorg,
  type DependencyInfoForReorg,
  type HubFileInfo,
  type ReorganizationSuggestion,
} from '../../core/gemini.js';
import { getGlobalApiKey, hasGlobalApiKey } from '../../commands/config.js';
import {
  findImportUpdatesForMoves,
  applyBatchMoves,
  calculateRelativeImport,
  type FileMove,
} from '../import-rewriter.js';
import { normalizeFilePath } from '../import-rewriter.helpers.js';
import type {
  ReorganizePlan,
  ReorganizeOperation,
  ReorganizeConflict,
  ReorganizeOptions,
  ReorganizeResult,
  ImportUpdate,
} from '../types.js';

// Entry point patterns that should never be moved
const PROTECTED_PATTERNS = [
  /^index\.(ts|tsx|js|jsx|mjs)$/,
  /^main\.(ts|tsx|js|jsx|mjs)$/,
  /^app\.(ts|tsx|js|jsx|mjs)$/,
  /^cli\.(ts|tsx|js|jsx|mjs)$/,
  /package\.json$/,
  /tsconfig\.json$/,
  /\.config\.(ts|js|mjs)$/,
];

// Backup directory for undo support
const BACKUP_DIR = '.consuela/reorganize-backup';

/**
 * Check if a file is a protected entry point
 */
function isProtectedFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  const dirname = path.dirname(filePath);

  // Only protect files at src root or project root
  const isRootLevel = dirname === 'src' || dirname === '.' || dirname === '';

  if (!isRootLevel) return false;

  return PROTECTED_PATTERNS.some(pattern => pattern.test(basename));
}

/**
 * Check if a path matches any exclude pattern
 */
function matchesExcludePattern(filePath: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    // Convert glob pattern to regex
    const regex = new RegExp(
      pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{GLOBSTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{GLOBSTAR\}\}/g, '.*')
    );
    if (regex.test(filePath)) {
      return true;
    }
  }
  return false;
}

/**
 * Progress callback type for reporting status
 */
export type ProgressCallback = (phase: string, message: string, current?: number, total?: number) => void;

/**
 * Create a file backup for undo support
 */
export function createBackup(
  rootDir: string,
  filesToBackup: string[]
): { backupId: string; backupDir: string } | null {
  try {
    const backupId = `backup-${Date.now()}`;
    const backupDir = path.join(rootDir, BACKUP_DIR, backupId);

    fs.mkdirSync(backupDir, { recursive: true });

    // Create manifest
    const manifest: { files: Array<{ original: string; backup: string }> } = {
      files: [],
    };

    for (const file of filesToBackup) {
      const fullPath = path.join(rootDir, file);
      if (!fs.existsSync(fullPath)) continue;

      const backupPath = path.join(backupDir, file);
      const backupFileDir = path.dirname(backupPath);

      if (!fs.existsSync(backupFileDir)) {
        fs.mkdirSync(backupFileDir, { recursive: true });
      }

      fs.copyFileSync(fullPath, backupPath);
      manifest.files.push({ original: file, backup: file });
    }

    // Save manifest
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    return { backupId, backupDir };
  } catch {
    return null;
  }
}

/**
 * Restore from a backup
 */
export function restoreFromBackup(rootDir: string, backupId?: string): boolean {
  try {
    const backupBaseDir = path.join(rootDir, BACKUP_DIR);

    // Find the backup to restore
    let targetBackupDir: string;
    if (backupId) {
      targetBackupDir = path.join(backupBaseDir, backupId);
    } else {
      // Find most recent backup
      if (!fs.existsSync(backupBaseDir)) return false;
      const backups = fs.readdirSync(backupBaseDir)
        .filter(d => d.startsWith('backup-'))
        .sort()
        .reverse();
      if (backups.length === 0) return false;
      targetBackupDir = path.join(backupBaseDir, backups[0]);
    }

    if (!fs.existsSync(targetBackupDir)) return false;

    // Read manifest
    const manifestPath = path.join(targetBackupDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

    // Restore files
    for (const entry of manifest.files) {
      const backupPath = path.join(targetBackupDir, entry.backup);
      const originalPath = path.join(rootDir, entry.original);

      if (fs.existsSync(backupPath)) {
        const originalDir = path.dirname(originalPath);
        if (!fs.existsSync(originalDir)) {
          fs.mkdirSync(originalDir, { recursive: true });
        }
        fs.copyFileSync(backupPath, originalPath);
      }
    }

    // Remove the backup after successful restore
    fs.rmSync(targetBackupDir, { recursive: true, force: true });

    return true;
  } catch {
    return false;
  }
}

/**
 * List available backups
 */
export function listBackups(rootDir: string): Array<{ id: string; date: Date; fileCount: number }> {
  const backupBaseDir = path.join(rootDir, BACKUP_DIR);
  if (!fs.existsSync(backupBaseDir)) return [];

  const backups: Array<{ id: string; date: Date; fileCount: number }> = [];

  for (const dir of fs.readdirSync(backupBaseDir)) {
    if (!dir.startsWith('backup-')) continue;

    const manifestPath = path.join(backupBaseDir, dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const timestamp = parseInt(dir.replace('backup-', ''), 10);
      backups.push({
        id: dir,
        date: new Date(timestamp),
        fileCount: manifest.files?.length || 0,
      });
    } catch {
      // Skip invalid backups
    }
  }

  return backups.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/**
 * Detect if reorganization would create circular dependencies
 */
export function detectCircularDependencies(
  moves: Array<{ from: string; to: string }>,
  importGraph: Map<string, Set<string>>
): Array<{ cycle: string[]; description: string }> {
  const cycles: Array<{ cycle: string[]; description: string }> = [];

  // Build new import graph with moved files
  const newGraph = new Map<string, Set<string>>();

  // Create mapping from old paths to new paths
  const pathMapping = new Map<string, string>();
  for (const move of moves) {
    pathMapping.set(move.from, move.to);
  }

  // Rebuild graph with new paths
  for (const [file, deps] of importGraph) {
    const newFile = pathMapping.get(file) || file;
    const newDeps = new Set<string>();

    for (const dep of deps) {
      const newDep = pathMapping.get(dep) || dep;
      newDeps.add(newDep);
    }

    newGraph.set(newFile, newDeps);
  }

  // Detect cycles using DFS
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(node: string, path: string[]): boolean {
    visited.add(node);
    recursionStack.add(node);

    const deps = newGraph.get(node) || new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        if (dfs(dep, [...path, dep])) {
          return true;
        }
      } else if (recursionStack.has(dep)) {
        // Found cycle
        const cycleStart = path.indexOf(dep);
        const cycle = cycleStart >= 0 ? path.slice(cycleStart) : [...path, dep];
        cycles.push({
          cycle,
          description: `Circular dependency: ${cycle.join(' → ')} → ${dep}`,
        });
        return true;
      }
    }

    recursionStack.delete(node);
    return false;
  }

  for (const node of newGraph.keys()) {
    if (!visited.has(node)) {
      dfs(node, [node]);
    }
  }

  return cycles;
}

/**
 * Check for tsconfig.json path alias updates needed
 */
export function detectTsconfigUpdates(
  moves: Array<{ from: string; to: string }>,
  rootDir: string
): Array<{ oldPath: string; newPath: string; alias: string }> {
  const updates: Array<{ oldPath: string; newPath: string; alias: string }> = [];

  // Read tsconfig.json
  const tsconfigPath = path.join(rootDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return updates;

  try {
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    const paths = tsconfig.compilerOptions?.paths;
    if (!paths) return updates;

    for (const [alias, targets] of Object.entries(paths)) {
      for (const target of targets as string[]) {
        // Check if any moved file matches this path
        for (const move of moves) {
          const targetPattern = target.replace(/\*/g, '(.*)');
          const regex = new RegExp(`^${targetPattern}$`);

          if (regex.test(move.from) || move.from.startsWith(target.replace('/*', '/'))) {
            updates.push({
              oldPath: target,
              newPath: target.replace(
                path.dirname(move.from),
                path.dirname(move.to)
              ),
              alias,
            });
          }
        }
      }
    }
  } catch {
    // Ignore parse errors
  }

  return updates;
}

/**
 * Analyze the codebase to gather information for reorganization
 */
export async function analyzeForReorganization(
  rootDir: string,
  targetDir?: string,
  excludePatterns: string[] = [],
  onProgress?: ProgressCallback
): Promise<{
  files: FileInfoForReorg[];
  dependencies: DependencyInfoForReorg[];
  hubFiles: HubFileInfo[];
  projectAnalysis: ProjectAnalysis;
  importGraph: Map<string, Set<string>>;
}> {
  onProgress?.('analysis', 'Running project analyzer...');

  // Run project analyzer for dependency info
  const analyzer = new ProjectAnalyzer(rootDir);
  const projectAnalysis = await analyzer.analyze();

  onProgress?.('analysis', 'Building dependency graph...');

  // Run graph analyzer for function-level insights
  const graphAnalyzer = new GraphAnalyzer({ rootDir });
  const insights = await graphAnalyzer.getGraphInsights();

  onProgress?.('analysis', 'Collecting file information...');

  // Build file info
  const files: FileInfoForReorg[] = [];
  const targetPrefix = targetDir ? targetDir.replace(/\/$/, '') : '';

  const totalFiles = projectAnalysis.files.size;
  let processedFiles = 0;

  for (const [filePath, fileAnalysis] of projectAnalysis.files) {
    processedFiles++;

    // Skip if not in target directory
    if (targetPrefix && !filePath.startsWith(targetPrefix)) continue;

    // Skip protected files
    if (isProtectedFile(filePath)) continue;

    // Skip excluded patterns
    if (matchesExcludePattern(filePath, excludePatterns)) continue;

    const exports = fileAnalysis.exports.map(e => e.name);
    const imports = fileAnalysis.imports
      .filter(i => i.resolvedPath)
      .map(i => i.resolvedPath!);

    // Count lines
    const fullPath = path.join(rootDir, filePath);
    let lineCount = 0;
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      lineCount = content.split('\n').length;
    } catch {
      continue;
    }

    files.push({
      path: filePath,
      exports,
      imports,
      lineCount,
    });

    if (processedFiles % 10 === 0) {
      onProgress?.('analysis', `Processed ${processedFiles}/${totalFiles} files`, processedFiles, totalFiles);
    }
  }

  onProgress?.('analysis', `Found ${files.length} files to analyze`);

  // Build dependency info
  const dependencies: DependencyInfoForReorg[] = [];
  for (const [filePath, deps] of projectAnalysis.importGraph) {
    if (targetPrefix && !filePath.startsWith(targetPrefix)) continue;
    if (matchesExcludePattern(filePath, excludePatterns)) continue;

    const dependsOn = Array.from(deps);
    const dependedOnBy = Array.from(projectAnalysis.reverseGraph.get(filePath) || []);

    dependencies.push({
      file: filePath,
      dependsOn,
      dependedOnBy,
    });
  }

  // Build hub files list from insights
  const hubFiles: HubFileInfo[] = insights.hubs.map(h => ({
    file: h.file,
    connections: h.connections,
  }));

  onProgress?.('analysis', `Identified ${hubFiles.length} hub files`);

  return {
    files,
    dependencies,
    hubFiles,
    projectAnalysis,
    importGraph: projectAnalysis.importGraph,
  };
}

/**
 * Get AI-suggested reorganization structure
 */
export async function getReorganizationSuggestion(
  files: FileInfoForReorg[],
  dependencies: DependencyInfoForReorg[],
  hubFiles: HubFileInfo[],
  options: { aggressive?: boolean } = {}
): Promise<ReorganizationSuggestion | null> {
  if (!hasGlobalApiKey()) {
    return null;
  }

  const apiKey = getGlobalApiKey();
  if (!apiKey) return null;

  const gemini = createGeminiClient(apiKey);
  return gemini.suggestReorganization(files, dependencies, hubFiles, options);
}

/**
 * Generate a reorganization plan from AI suggestion
 */
export async function generateReorganizePlan(
  suggestion: ReorganizationSuggestion,
  rootDir: string,
  options: ReorganizeOptions = {}
): Promise<ReorganizePlan> {
  const operations: ReorganizeOperation[] = [];
  const conflicts: ReorganizeConflict[] = [];
  const foldersToCreate = new Set<string>();
  const fileMoves: Array<{ from: string; to: string; reason?: string }> = [];

  // Track destination paths for collision detection
  const destinationPaths = new Map<string, string>(); // normalized path -> original move from

  // Process each domain
  for (const domain of suggestion.domains) {
    // Add folder creation
    const folderPath = domain.folder;
    foldersToCreate.add(folderPath);

    // Process file moves
    for (const file of domain.files) {
      // Check if source file exists
      const sourcePath = path.join(rootDir, file.currentPath);
      if (!fs.existsSync(sourcePath)) {
        conflicts.push({
          type: 'missing-file',
          description: `Source file does not exist: ${file.currentPath}`,
          files: [file.currentPath],
          resolution: 'Skip this file move',
        });
        continue;
      }

      // Check if file is protected
      if (isProtectedFile(file.currentPath)) {
        conflicts.push({
          type: 'entry-point',
          description: `Cannot move entry point: ${file.currentPath}`,
          files: [file.currentPath],
          resolution: 'Entry points should not be moved',
        });
        continue;
      }

      // Check for destination collision
      const normalizedDest = file.newPath.toLowerCase();
      const existingMove = destinationPaths.get(normalizedDest);
      if (existingMove) {
        conflicts.push({
          type: 'name-collision',
          description: `Multiple files would be moved to ${file.newPath}`,
          files: [existingMove, file.currentPath],
          resolution: 'Rename one of the destination files',
        });
        continue;
      }

      // Check if destination already exists (and isn't being moved)
      const destPath = path.join(rootDir, file.newPath);
      if (fs.existsSync(destPath)) {
        const isBeingMoved = suggestion.domains.some(d =>
          d.files.some(f => f.currentPath === file.newPath)
        );
        if (!isBeingMoved) {
          conflicts.push({
            type: 'name-collision',
            description: `Destination already exists: ${file.newPath}`,
            files: [file.currentPath, file.newPath],
            resolution: 'Choose a different destination path',
          });
          continue;
        }
      }

      // Skip no-op moves (source === destination)
      if (file.currentPath === file.newPath) {
        continue;
      }

      destinationPaths.set(normalizedDest, file.currentPath);
      fileMoves.push({ from: file.currentPath, to: file.newPath, reason: file.reason });

      // Also add parent directories of the new path (for nested structures)
      const newDir = path.dirname(file.newPath);
      if (newDir !== domain.folder && newDir !== '.') {
        foldersToCreate.add(newDir);
      }
    }
  }

  // Build domain metadata for display
  const domainMetadata = suggestion.domains.map(domain => ({
    name: domain.name,
    folder: domain.folder,
    description: domain.description,
    files: domain.files
      .filter(f => fileMoves.some(m => m.from === f.currentPath))
      .map(f => path.basename(f.newPath)),
  }));

  // Calculate import updates for each move
  const config = { rootDir, ignore: [] };
  const importUpdateMap = await findImportUpdatesForMoves(
    fileMoves.map(m => ({ from: m.from, to: m.to })),
    config
  );

  let totalImportUpdates = 0;

  // Create folder operations first
  for (const folder of foldersToCreate) {
    operations.push({ type: 'create-folder', path: folder });
  }

  // Create move operations with import updates
  for (const move of fileMoves) {
    const importUpdates: ImportUpdate[] = [];
    const normalizedMovedFile = normalizeFilePath(path.resolve(rootDir, move.from));

    // Get updates for files importing THIS specific moved file
    for (const [file, changes] of importUpdateMap) {
      for (const change of changes) {
        if (!change.oldSource || !change.newSource) continue;

        // Check if this change is for the current moved file
        const resolvedPath = change.location.resolvedPath;
        if (!resolvedPath) continue;

        const normalizedResolved = normalizeFilePath(
          path.isAbsolute(resolvedPath)
            ? resolvedPath
            : path.resolve(rootDir, resolvedPath)
        );

        if (normalizedResolved === normalizedMovedFile) {
          importUpdates.push({
            file,
            oldSource: change.oldSource,
            newSource: change.newSource,
          });
        }
      }
    }

    totalImportUpdates += importUpdates.length;

    operations.push({
      type: 'move-file',
      from: move.from,
      to: move.to,
      importUpdates,
      reason: move.reason,
    });
  }

  // Create barrel file operations based on actual file exports
  for (const domain of suggestion.domains) {
    // Generate barrel for each domain based on actual exports
    const barrelPath = path.join(domain.folder, 'index.ts');
    const domainFiles = domain.files.filter(f =>
      fileMoves.some(m => m.from === f.currentPath)
    );

    if (domainFiles.length > 0) {
      const barrelContent = generateBarrelContent(
        { files: domainFiles },
        rootDir,
        barrelPath
      );

      if (barrelContent.trim()) {
        operations.push({
          type: 'create-barrel',
          path: barrelPath,
          content: barrelContent,
        });
      }
    }
  }

  // Determine risk level
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
  if (conflicts.length > 0) {
    riskLevel = 'HIGH';
  } else if (fileMoves.length > 10 || totalImportUpdates > 50) {
    riskLevel = 'MEDIUM';
  }

  return {
    operations,
    summary: {
      foldersToCreate: Array.from(foldersToCreate),
      filesToMove: fileMoves.length,
      importsToRewrite: totalImportUpdates,
      barrelFilesToCreate: suggestion.barrelFiles.length,
    },
    conflicts,
    riskLevel,
    reasoning: suggestion.reasoning,
    domains: domainMetadata,
  };
}

/**
 * Generate barrel file content from actual files in a domain
 */
function generateBarrelContent(
  domain: { files: Array<{ currentPath: string; newPath: string }> },
  rootDir: string,
  barrelPath: string
): string {
  const exportLines: string[] = [];
  const barrelDir = path.dirname(barrelPath);

  for (const file of domain.files) {
    const sourcePath = path.join(rootDir, file.currentPath);
    if (!fs.existsSync(sourcePath)) continue;

    try {
      const content = fs.readFileSync(sourcePath, 'utf-8');
      const exports = extractExportsFromContent(content);

      // Compute relative path from barrel file to the new file location
      const newFileDir = path.dirname(file.newPath);
      const fileName = path.basename(file.newPath, path.extname(file.newPath));

      let relativePath: string;
      if (newFileDir === barrelDir) {
        // File is in same directory as barrel
        relativePath = './' + fileName + '.js';
      } else {
        // File is in a subdirectory relative to barrel
        const relDir = path.relative(barrelDir, newFileDir);
        relativePath = './' + relDir.replace(/\\/g, '/') + '/' + fileName + '.js';
      }

      for (const exp of exports) {
        if (exp.isDefault) {
          // Re-export default as named export using filename
          const exportName = toCamelCase(fileName);
          exportLines.push(`export { default as ${exportName} } from '${relativePath}';`);
        } else {
          exportLines.push(`export { ${exp.name} } from '${relativePath}';`);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return exportLines.join('\n') + '\n';
}

/**
 * Extract export names from file content
 */
function extractExportsFromContent(content: string): Array<{ name: string; isDefault: boolean }> {
  const exports: Array<{ name: string; isDefault: boolean }> = [];

  // Match export declarations
  const patterns = [
    // export function name
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    // export const/let/var name
    /export\s+(?:const|let|var)\s+(\w+)/g,
    // export class name
    /export\s+class\s+(\w+)/g,
    // export interface/type name
    /export\s+(?:interface|type)\s+(\w+)/g,
    // export enum name
    /export\s+enum\s+(\w+)/g,
    // export { name }
    /export\s*\{([^}]+)\}/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (pattern.source.includes('{')) {
        // Handle export { a, b, c }
        const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
        for (const name of names) {
          if (name && !exports.some(e => e.name === name)) {
            exports.push({ name, isDefault: false });
          }
        }
      } else {
        const name = match[1];
        if (name && !exports.some(e => e.name === name)) {
          exports.push({ name, isDefault: false });
        }
      }
    }
  }

  // Check for default export
  if (/export\s+default\s+/.test(content)) {
    exports.push({ name: 'default', isDefault: true });
  }

  return exports;
}

/**
 * Convert kebab-case to camelCase
 */
function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Create a rollback point using git
 */
export function createRollbackPoint(rootDir: string): string | null {
  try {
    // Check if in a git repo
    execSync('git rev-parse --git-dir', { cwd: rootDir, stdio: 'pipe' });

    // Create a stash
    const stashName = `consuela-reorganize-${Date.now()}`;
    execSync(`git stash push -m "${stashName}"`, { cwd: rootDir, stdio: 'pipe' });

    return stashName;
  } catch {
    return null;
  }
}

/**
 * Rollback changes using git
 */
export function rollback(rootDir: string, _stashName: string): boolean {
  try {
    execSync('git stash pop', { cwd: rootDir, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify the build after reorganization
 */
export function verifyBuild(rootDir: string): { success: boolean; errors: string[] } {
  try {
    execSync('npx tsc --noEmit', { cwd: rootDir, stdio: 'pipe' });
    return { success: true, errors: [] };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      errors: [errorMessage],
    };
  }
}

/**
 * Execute a reorganization plan
 */
export async function executeReorganizePlan(
  plan: ReorganizePlan,
  rootDir: string,
  options: ReorganizeOptions = {},
  onProgress?: ProgressCallback
): Promise<ReorganizeResult> {
  const result: ReorganizeResult = {
    success: false,
    plan,
    movedFiles: [],
    updatedImports: [],
    createdBarrels: [],
    errors: [],
    warnings: [],
  };

  // Check for conflicts
  if (plan.conflicts.length > 0 && !options.yes) {
    result.errors.push(`Plan has ${plan.conflicts.length} conflict(s). Review and resolve before executing.`);
    return result;
  }

  // Extract file moves from operations
  const fileMoves: FileMove[] = [];
  const foldersToCreate: string[] = [];
  const barrelsToCreate: Array<{ path: string; content: string }> = [];

  for (const op of plan.operations) {
    if (op.type === 'create-folder') {
      foldersToCreate.push(op.path);
    } else if (op.type === 'move-file') {
      fileMoves.push({ from: op.from, to: op.to });
    } else if (op.type === 'create-barrel') {
      barrelsToCreate.push({ path: op.path, content: op.content });
    }
  }

  if (options.dryRun) {
    // Just return what would happen
    result.success = true;
    result.movedFiles = fileMoves;
    result.createdBarrels = barrelsToCreate.map(b => b.path);
    return result;
  }

  // Create rollback point
  const rollbackPoint = createRollbackPoint(rootDir);
  if (!rollbackPoint) {
    result.warnings.push('Could not create git rollback point. Proceeding without rollback support.');
  }

  try {
    // Step 1: Create folders
    for (const folder of foldersToCreate) {
      const folderPath = path.join(rootDir, folder);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
    }

    // Step 2: Apply batch moves with import updates
    const config = { rootDir, ignore: [], dryRun: options.dryRun };
    const moveResult = await applyBatchMoves(fileMoves, config, { dryRun: false });

    if (!moveResult.success) {
      result.errors.push(...moveResult.errors);
      if (rollbackPoint) {
        rollback(rootDir, rollbackPoint);
      }
      return result;
    }

    result.movedFiles = moveResult.movedFiles;
    result.updatedImports = Array.from(moveResult.updatedImports.keys());

    // Step 3: Create barrel files
    for (const barrel of barrelsToCreate) {
      const barrelPath = path.join(rootDir, barrel.path);
      const barrelDir = path.dirname(barrelPath);

      if (!fs.existsSync(barrelDir)) {
        fs.mkdirSync(barrelDir, { recursive: true });
      }

      fs.writeFileSync(barrelPath, barrel.content, 'utf-8');
      result.createdBarrels.push(barrel.path);
    }

    // Step 4: Verify build
    const verification = verifyBuild(rootDir);
    if (!verification.success) {
      result.errors.push('Build verification failed:', ...verification.errors);
      result.warnings.push('Changes have been applied. Run `git stash pop` to rollback if needed.');
      return result;
    }

    result.success = true;

    // Step 5: Optionally commit
    try {
      execSync('git add -A', { cwd: rootDir, stdio: 'pipe' });
      execSync(`git commit -m "refactor: reorganize codebase structure\n\nGenerated by consuela reorganize"`, {
        cwd: rootDir,
        stdio: 'pipe',
      });
    } catch {
      result.warnings.push('Could not auto-commit changes. Please commit manually.');
    }

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(`Execution failed: ${errorMessage}`);

    if (rollbackPoint) {
      const rolledBack = rollback(rootDir, rollbackPoint);
      if (rolledBack) {
        result.warnings.push('Changes have been rolled back.');
      } else {
        result.warnings.push('Failed to rollback. Manual recovery may be needed.');
      }
    }
  }

  return result;
}

/**
 * Main entry point for reorganization
 */
export async function reorganize(
  options: ReorganizeOptions = {},
  onProgress?: ProgressCallback
): Promise<ReorganizeResult> {
  const rootDir = options.rootDir || process.cwd();
  const excludePatterns = options.exclude || [];

  // Step 1: Analysis
  onProgress?.('analysis', 'Starting codebase analysis...');
  const { files, dependencies, hubFiles, importGraph } = await analyzeForReorganization(
    rootDir,
    options.targetDir,
    excludePatterns,
    onProgress
  );

  if (files.length === 0) {
    return {
      success: false,
      plan: {
        operations: [],
        summary: { foldersToCreate: [], filesToMove: 0, importsToRewrite: 0, barrelFilesToCreate: 0 },
        conflicts: [],
        riskLevel: 'LOW',
      },
      movedFiles: [],
      updatedImports: [],
      createdBarrels: [],
      errors: ['No files found to reorganize'],
      warnings: [],
    };
  }

  // Step 2: Get AI suggestion
  onProgress?.('ai', 'Getting AI reorganization suggestion...');
  const suggestion = await getReorganizationSuggestion(
    files,
    dependencies,
    hubFiles,
    { aggressive: options.aggressive }
  );

  if (!suggestion || suggestion.domains.length === 0) {
    return {
      success: false,
      plan: {
        operations: [],
        summary: { foldersToCreate: [], filesToMove: 0, importsToRewrite: 0, barrelFilesToCreate: 0 },
        conflicts: [],
        riskLevel: 'LOW',
      },
      movedFiles: [],
      updatedImports: [],
      createdBarrels: [],
      errors: ['Could not generate reorganization suggestion. Ensure Gemini API key is configured.'],
      warnings: [],
    };
  }

  // Step 3: Generate plan
  onProgress?.('planning', 'Generating reorganization plan...');
  const plan = await generateReorganizePlan(suggestion, rootDir, options);

  // Step 4: Safety checks
  onProgress?.('validation', 'Running safety checks...');
  const moves = plan.operations
    .filter((op): op is Extract<ReorganizeOperation, { type: 'move-file' }> => op.type === 'move-file')
    .map(op => ({ from: op.from, to: op.to }));

  // Check for circular dependencies
  const circularDeps = detectCircularDependencies(moves, importGraph);
  if (circularDeps.length > 0) {
    for (const cycle of circularDeps) {
      plan.conflicts.push({
        type: 'circular-move',
        description: cycle.description,
        files: cycle.cycle,
        resolution: 'Review the proposed structure to avoid circular imports',
      });
    }
    plan.riskLevel = 'HIGH';
  }

  // Check for tsconfig updates needed
  const tsconfigUpdates = detectTsconfigUpdates(moves, rootDir);
  const warnings: string[] = plan.conflicts.map(c => c.description);
  if (tsconfigUpdates.length > 0) {
    warnings.push(`tsconfig.json may need path alias updates for ${tsconfigUpdates.length} path(s)`);
  }

  // Step 5: Execute (if not dry-run)
  if (options.dryRun) {
    return {
      success: true,
      plan,
      movedFiles: moves,
      updatedImports: [],
      createdBarrels: plan.operations
        .filter((op): op is Extract<ReorganizeOperation, { type: 'create-barrel' }> => op.type === 'create-barrel')
        .map(op => op.path),
      errors: [],
      warnings,
    };
  }

  // Create backup if requested
  if (options.backup !== false) {
    onProgress?.('backup', 'Creating backup...');
    const filesToBackup = [
      ...moves.map(m => m.from),
      ...Array.from(new Set(
        moves.flatMap(m => m.from) // Files that will be modified
      )),
    ];
    const backup = createBackup(rootDir, filesToBackup);
    if (backup) {
      warnings.push(`Backup created: ${backup.backupId}. Use 'consuela reorganize --undo' to restore.`);
    }
  }

  return executeReorganizePlan(plan, rootDir, options, onProgress);
}

/**
 * Preview reorganization without applying changes
 */
export async function previewReorganization(
  options: ReorganizeOptions = {},
  onProgress?: ProgressCallback
): Promise<{
  plan: ReorganizePlan;
  currentTree: string;
  proposedTree: string;
  safetyWarnings: string[];
  tsconfigUpdates: Array<{ oldPath: string; newPath: string; alias: string }>;
}> {
  const rootDir = options.rootDir || process.cwd();
  const excludePatterns = options.exclude || [];

  // Get analysis and suggestion
  const { files, dependencies, hubFiles, importGraph } = await analyzeForReorganization(
    rootDir,
    options.targetDir,
    excludePatterns,
    onProgress
  );

  onProgress?.('ai', 'Getting AI suggestion...');
  const suggestion = await getReorganizationSuggestion(
    files,
    dependencies,
    hubFiles,
    { aggressive: options.aggressive }
  );

  if (!suggestion) {
    return {
      plan: {
        operations: [],
        summary: { foldersToCreate: [], filesToMove: 0, importsToRewrite: 0, barrelFilesToCreate: 0 },
        conflicts: [],
        riskLevel: 'LOW',
      },
      currentTree: '',
      proposedTree: '',
      safetyWarnings: [],
      tsconfigUpdates: [],
    };
  }

  onProgress?.('planning', 'Generating plan...');
  const plan = await generateReorganizePlan(suggestion, rootDir, options);

  // Safety checks
  onProgress?.('validation', 'Running safety checks...');
  const moves = plan.operations
    .filter((op): op is Extract<ReorganizeOperation, { type: 'move-file' }> => op.type === 'move-file')
    .map(op => ({ from: op.from, to: op.to }));

  const safetyWarnings: string[] = [];

  // Check for circular dependencies
  const circularDeps = detectCircularDependencies(moves, importGraph);
  if (circularDeps.length > 0) {
    for (const cycle of circularDeps) {
      plan.conflicts.push({
        type: 'circular-move',
        description: cycle.description,
        files: cycle.cycle,
        resolution: 'Review the proposed structure to avoid circular imports',
      });
      safetyWarnings.push(cycle.description);
    }
    plan.riskLevel = 'HIGH';
  }

  // Check for tsconfig updates needed
  const tsconfigUpdates = detectTsconfigUpdates(moves, rootDir);
  if (tsconfigUpdates.length > 0) {
    safetyWarnings.push(`tsconfig.json may need updates for ${tsconfigUpdates.length} path alias(es)`);
  }

  // Build tree representations
  const currentTree = buildTreeString(files.map(f => f.path));

  // Build proposed tree from plan
  const proposedPaths = new Set<string>();
  for (const op of plan.operations) {
    if (op.type === 'move-file') {
      proposedPaths.add(op.to);
    } else if (op.type === 'create-barrel') {
      proposedPaths.add(op.path);
    }
  }

  // Add files that aren't being moved
  const movedFroms = new Set(
    plan.operations
      .filter((op): op is Extract<ReorganizeOperation, { type: 'move-file' }> => op.type === 'move-file')
      .map(op => op.from)
  );
  for (const file of files) {
    if (!movedFroms.has(file.path)) {
      proposedPaths.add(file.path);
    }
  }

  const proposedTree = buildTreeString(Array.from(proposedPaths));

  onProgress?.('done', 'Preview ready');

  return { plan, currentTree, proposedTree, safetyWarnings, tsconfigUpdates };
}

/**
 * Build a tree string representation of file paths
 */
function buildTreeString(paths: string[]): string {
  const sortedPaths = [...paths].sort();
  const lines: string[] = [];

  interface TreeNode {
    name: string;
    children: Map<string, TreeNode>;
    isFile: boolean;
  }

  // Build tree structure
  const root: TreeNode = { name: '', children: new Map(), isFile: false };

  for (const p of sortedPaths) {
    const parts = p.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          children: new Map(),
          isFile: isLast,
        });
      }
      current = current.children.get(part)!;
    }
  }

  // Render tree
  function render(node: TreeNode, prefix: string, isLast: boolean): void {
    if (node.name) {
      const connector = isLast ? '└── ' : '├── ';
      lines.push(prefix + connector + node.name + (node.isFile ? '' : '/'));
    }

    const children = Array.from(node.children.values());
    children.forEach((child, index) => {
      const newPrefix = node.name ? prefix + (isLast ? '    ' : '│   ') : '';
      render(child, newPrefix, index === children.length - 1);
    });
  }

  render(root, '', true);
  return lines.join('\n');
}
