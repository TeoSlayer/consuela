/**
 * auto-fix - Autonomous refactoring with AI decision making
 *
 * This is the "just clean it up" command that:
 * 1. Analyzes the codebase to find problems
 * 2. Uses AI to decide what to fix and in what order
 * 3. Applies fixes one at a time
 * 4. Validates structure after each change
 * 5. Rolls back if something breaks
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createConfiguredAnalyzer, createGeminiClient } from '../../core/index.js';
import { createGraphAnalyzer } from '../../graph/index.js';
import { cleanup } from './cleanup.js';
import { mergeFiles } from './merge.js';
import { splitFile, parseSourceFile, type SplitResult } from './split.js';
import { hasGlobalApiKey, getGlobalApiKey } from '../../commands/config.js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AutoFixOptions, FixAction } from '../types.js';
import { countLinesChanged, getCodebaseStats, diagnoseCodebase } from './diagnostics.js';

export interface AutoFixResult {
  success: boolean;
  iterations: number;
  actionsApplied: FixAction[];
  actionsFailed: Array<FixAction & { error: string }>;
  beforeStats: {
    files: number;
    functions: number;
    unusedExports: number;
    criticalIssues: number;
    warnings: number;
  };
  afterStats: {
    files: number;
    functions: number;
    unusedExports: number;
    criticalIssues: number;
    warnings: number;
  };
  structureValid: boolean;
  /** Files that were actually modified */
  filesModified: string[];
  /** Total lines changed (added + removed) */
  linesChanged: number;
  /** Git commits created (if git integration enabled) */
  commitsCreated: string[];
}

interface DiagnosisResult {
  score: number;
  problems: Array<{
    severity: 'critical' | 'warning' | 'info';
    category: string;
    file?: string;
    message: string;
    suggestion?: string;
  }>;
  stats: {
    totalFiles: number;
    totalFunctions: number;
    unusedExports: number;
    largestFile: { path: string; lines: number };
  };
  /** Graph-based insights for smarter decisions */
  graphInsights?: {
    hubs: Array<{ name: string; file: string; connections: number }>;
    tightlyCoupledFiles: Array<{ files: string[]; edges: number }>;
    extractionCandidates: Array<{ file: string; functions: string[]; score: number }>;
    isolatedFunctions: string[];
    criticalPaths: Array<{ from: string; to: string; length: number }>;
  };
}

/** Result of applying an action with change tracking */
interface ActionResult {
  success: boolean;
  filesModified: string[];
  linesChanged: number;
  error?: string;
}

// ============================================================================
// Git Utilities
// ============================================================================

/**
 * Check if the current directory is a git repository
 */
function isGitRepo(): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore', cwd: process.cwd() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for uncommitted changes in the git repository
 */
function hasUncommittedChanges(): boolean {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd() });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get list of uncommitted files
 */
function getUncommittedFiles(): string[] {
  try {
    const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd() });
    return status
      .split('\n')
      .filter(line => line.trim())
      .map(line => line.slice(3).trim());
  } catch {
    return [];
  }
}

/**
 * Create a git commit with the given message
 */
function gitCommit(message: string): string | null {
  try {
    // Stage all changes
    execSync('git add -A', { cwd: process.cwd(), stdio: 'ignore' });

    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: process.cwd(),
      stdio: 'ignore'
    });

    // Get the commit hash
    const hash = execSync('git rev-parse HEAD', { encoding: 'utf-8', cwd: process.cwd() }).trim();
    return hash.slice(0, 8);
  } catch {
    return null;
  }
}

/**
 * Rollback all uncommitted changes
 */
function gitRollback(): boolean {
  try {
    execSync('git checkout -- .', { cwd: process.cwd(), stdio: 'ignore' });
    // Also clean up any untracked files that were created
    execSync('git clean -fd', { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Build Verification
// ============================================================================

/**
 * Run the build command and check if it succeeds
 */
function runBuildVerification(): { success: boolean; error?: string } {
  const rootDir = process.cwd();

  // Check for package.json to determine build command
  const packageJsonPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    // No package.json, try tsc directly
    try {
      execSync('npx tsc --noEmit', { cwd: rootDir, stdio: 'pipe' });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr)
        : 'TypeScript compilation failed';
      return { success: false, error: message };
    }
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    const scripts = packageJson.scripts || {};

    // Prefer a type-check only command to avoid full build
    let buildCommand = 'npm run build';
    if (scripts['typecheck']) {
      buildCommand = 'npm run typecheck';
    } else if (scripts['type-check']) {
      buildCommand = 'npm run type-check';
    } else if (scripts['build']) {
      buildCommand = 'npm run build';
    } else {
      // No build script, try tsc directly
      buildCommand = 'npx tsc --noEmit';
    }

    execSync(buildCommand, { cwd: rootDir, stdio: 'pipe' });
    return { success: true };
  } catch (error) {
    // TypeScript outputs errors to stdout, npm scripts may use stderr
    let message = 'Build failed';
    if (error instanceof Error) {
      const execError = error as { stdout?: Buffer; stderr?: Buffer };
      if (execError.stdout && execError.stdout.length > 0) {
        message = execError.stdout.toString();
      } else if (execError.stderr && execError.stderr.length > 0) {
        message = execError.stderr.toString();
      }
    }
    return { success: false, error: message };
  }
}

/**
 * Main auto-fix function - the autonomous refactoring agent
 */
export async function autoFix(options: AutoFixOptions = {}): Promise<AutoFixResult> {
  const maxIterations = options.maxIterations ?? 10;
  const actionsApplied: FixAction[] = [];
  const actionsFailed: Array<FixAction & { error: string }> = [];
  const filesModified: Set<string> = new Set();
  let totalLinesChanged = 0;
  const commitsCreated: string[] = [];

  // Git integration setup
  const useGit = options.git !== false && isGitRepo();
  const useBuildVerify = options.verify !== false;

  // Check for uncommitted changes if using git
  if (useGit && hasUncommittedChanges()) {
    const uncommittedFiles = getUncommittedFiles();
    if (options.verbose) {
      console.log(`\n⚠️  Warning: Uncommitted changes detected in ${uncommittedFiles.length} files:`);
      for (const file of uncommittedFiles.slice(0, 5)) {
        console.log(`     - ${file}`);
      }
      if (uncommittedFiles.length > 5) {
        console.log(`     ... and ${uncommittedFiles.length - 5} more`);
      }
      console.log('\n   Consider committing or stashing changes before running fix.');
      console.log('   Proceeding anyway - rollback may affect these files.\n');
    }
  }

  // Get initial stats
  const beforeStats = await getCodebaseStats();

  // Save initial Gold Standard for verification
  const graphAnalyzer = createGraphAnalyzer();
  let goldStandard = graphAnalyzer.loadGoldStandard();

  if (!goldStandard && !options.skipVerify) {
    // Create initial Gold Standard
    goldStandard = await graphAnalyzer.buildGraph();
    graphAnalyzer.saveGoldStandard(goldStandard);
  }

  let iteration = 0;
  let continueFixing = true;
  let lastProblemCount = Infinity;
  let stuckCount = 0;

  while (continueFixing && iteration < maxIterations) {
    iteration++;

    if (options.verbose) {
      console.log(`\n--- Iteration ${iteration} ---`);
    }

    // 1. Diagnose current state
    const diagnosis = await diagnoseCodebase();
    const currentProblemCount = diagnosis.problems.length;

    if (options.verbose) {
      console.log(`  Score: ${diagnosis.score}/100`);
      console.log(`  Critical: ${diagnosis.problems.filter(p => p.severity === 'critical').length}`);
      console.log(`  Warnings: ${diagnosis.problems.filter(p => p.severity === 'warning').length}`);

      // Show graph insights being used
      if (diagnosis.graphInsights) {
        const gi = diagnosis.graphInsights;
        if (gi.hubs.length > 0) {
          console.log(`  Graph: Hub functions: ${gi.hubs.slice(0, 3).map(h => h.name).join(', ')}`);
        }
        if (gi.extractionCandidates.length > 0) {
          console.log(`  Graph: Extraction candidates: ${gi.extractionCandidates.length} cohesive groups`);
        }
        if (gi.tightlyCoupledFiles.length > 0) {
          console.log(`  Graph: Coupled files: ${gi.tightlyCoupledFiles.length} pairs`);
        }
        if (gi.isolatedFunctions.length > 0) {
          console.log(`  Graph: Isolated (dead?): ${gi.isolatedFunctions.length} functions`);
        }
      }
    }

    // 2. If score is good enough, stop
    if (diagnosis.score >= 80 || diagnosis.problems.length === 0) {
      continueFixing = false;
      break;
    }

    // Check if we're making progress
    if (currentProblemCount >= lastProblemCount) {
      stuckCount++;
      if (stuckCount >= 2) {
        if (options.verbose) {
          console.log(`  No progress after ${stuckCount} iterations, stopping.`);
        }
        continueFixing = false;
        break;
      }
    } else {
      stuckCount = 0;
    }
    lastProblemCount = currentProblemCount;

    // 3. AI decides next action
    const action = await decideNextAction(diagnosis, actionsApplied, options);

    if (action.type === 'skip') {
      if (options.verbose) {
        console.log(`  Skipping: ${action.reason}`);
      }
      continueFixing = false;
      break;
    }

    if (options.verbose) {
      console.log(`  Action: ${action.type} - ${action.reason}`);
    }

    if (options.dryRun) {
      actionsApplied.push(action);
      continue;
    }

    // 4. Apply the action with change tracking
    const actionResult = await applyActionWithTracking(action, options, diagnosis);

    if (!actionResult.success) {
      actionsFailed.push({ ...action, error: actionResult.error || 'Unknown error' });

      if (options.verbose) {
        console.log(`  Failed: ${actionResult.error}`);
      }

      // Rollback on failure if using git
      if (useGit) {
        if (options.verbose) {
          console.log(`  Rolling back changes...`);
        }
        gitRollback();
      }
      continue;
    }

    // Check if any files were actually modified
    if (actionResult.filesModified.length === 0) {
      if (options.verbose) {
        console.log(`  No changes made - skipping`);
      }
      // Mark as tried even if no changes, so we don't loop forever
      actionsApplied.push(action);
      continue;
    }

    // Track changes
    for (const file of actionResult.filesModified) {
      filesModified.add(file);
    }
    totalLinesChanged += actionResult.linesChanged;

    if (options.verbose) {
      console.log(`  Modified ${actionResult.filesModified.length} files, ${actionResult.linesChanged} lines changed`);
    }

    // 5. Build verification (unless skipped)
    if (useBuildVerify) {
      if (options.verbose) {
        console.log(`  Verifying build...`);
      }

      const buildResult = runBuildVerification();

      if (!buildResult.success) {
        if (options.verbose) {
          console.log(`  Build failed! Rolling back...`);
          if (buildResult.error) {
            // Show first few lines of error
            const errorLines = buildResult.error.split('\n').slice(0, 5);
            for (const line of errorLines) {
              console.log(`    ${line}`);
            }
          }
        }

        // Rollback
        if (useGit) {
          gitRollback();
        }

        actionsFailed.push({
          ...action,
          error: `Build verification failed: ${buildResult.error?.split('\n')[0] || 'Unknown error'}`
        });
        continue;
      }

      if (options.verbose) {
        console.log(`  Build verified OK`);
      }
    }

    // 6. Verify structure (unless skipped)
    if (!options.skipVerify && goldStandard) {
      const verification = await graphAnalyzer.verify();

      // Check if the change is safe (no signature changes, no removed public functions)
      const isSafe = verification.diff.signatureChanges.length === 0 &&
                     verification.diff.removedFunctions.length === 0;

      if (!isSafe) {
        // Breaking change - this shouldn't happen with our operations
        // but log it as a warning
        if (options.verbose) {
          console.log(`  Warning: Structural change detected`);
          for (const change of verification.diff.summary) {
            console.log(`    - ${change}`);
          }
        }
      }

      // Update Gold Standard after safe changes
      const newGraph = await graphAnalyzer.buildGraph();
      graphAnalyzer.saveGoldStandard(newGraph);
    }

    // 7. Git commit (if enabled)
    if (useGit) {
      const commitMessage = generateCommitMessage(action);
      const commitHash = gitCommit(commitMessage);

      if (commitHash) {
        commitsCreated.push(commitHash);
        if (options.verbose) {
          console.log(`  Committed: ${commitHash} - ${commitMessage.split('\n')[0]}`);
        }
      }
    }

    actionsApplied.push(action);
  }

  // Get final stats
  const afterStats = await getCodebaseStats();

  // Final structure check
  let structureValid = true;
  if (!options.skipVerify && goldStandard) {
    try {
      const verification = await graphAnalyzer.verify();
      // Structure is valid if no breaking changes (no signature changes, no removed functions)
      structureValid = verification.diff.signatureChanges.length === 0 &&
                       verification.diff.removedFunctions.length === 0;
    } catch {
      structureValid = false;
    }
  }

  return {
    success: actionsFailed.length === 0,
    iterations: iteration,
    actionsApplied,
    actionsFailed,
    beforeStats,
    afterStats,
    structureValid,
    filesModified: Array.from(filesModified),
    linesChanged: totalLinesChanged,
    commitsCreated,
  };
}

/**
 * Generate a commit message for an action
 */
function generateCommitMessage(action: FixAction): string {
  switch (action.type) {
    case 'cleanup':
      return `refactor: remove unused exports\n\n${action.reason}`;
    case 'split':
      return `refactor: split ${action.target || 'file'}\n\n${action.reason}`;
    case 'merge':
      return `refactor: merge files\n\n${action.reason}`;
    default:
      return `refactor: ${action.reason}`;
  }
}

/**
 * AI decides what action to take next
 */
async function decideNextAction(
  diagnosis: DiagnosisResult,
  previousActions: FixAction[],
  options: AutoFixOptions
): Promise<FixAction> {
  // Track what we've already tried
  const attemptedCleanup = previousActions.some(a => a.type === 'cleanup');

  // Priority 1: Always clean up dead code first (safest) - but only once
  const deadCodeProblems = diagnosis.problems.filter(p => p.category === 'dead-code');
  if (deadCodeProblems.length > 0 && !attemptedCleanup) {
    return {
      type: 'cleanup',
      reason: `Remove ${deadCodeProblems.length} unused exports`,
      details: { count: deadCodeProblems.length },
    };
  }

  // Priority 2: Try SEMANTIC analysis for large files (AI-powered)
  // Groups functions by what they DO, not how they're connected
  const largeFiles = diagnosis.problems
    .filter((p: { category: string; severity: string }) => p.category === 'file-size' && p.severity === 'critical')
    .sort((a: { message: string }, b: { message: string }) => {
      const aLines = parseInt(a.message) || 0;
      const bLines = parseInt(b.message) || 0;
      return bLines - aLines;
    });

  if (options.aggressive && largeFiles.length > 0 && hasGlobalApiKey()) {
    for (const problem of largeFiles) {
      if (!problem.file) continue;

      const alreadyTriedSemantic = previousActions.some(
        (a: FixAction) => a.type === 'split' && a.target === problem.file && a.details?.semanticBased
      );

      if (!alreadyTriedSemantic) {
        try {
          const graphAnalyzer = createGraphAnalyzer();
          const semanticResult = await graphAnalyzer.getSemanticExtractionCandidates(problem.file, 150);

          if (semanticResult && semanticResult.groups.length > 0) {
            const bestGroup = semanticResult.groups
              .sort((a: { functions: string[] }, b: { functions: string[] }) => b.functions.length - a.functions.length)[0];

            if (bestGroup && bestGroup.functions.length >= 2) {
              return {
                type: 'split',
                reason: `Semantic split: Extract "${bestGroup.name}" (${bestGroup.functions.length} functions) - ${bestGroup.description}`,
                target: problem.file,
                details: {
                  functions: bestGroup.functions,
                  semanticBased: true,
                  suggestedFileName: bestGroup.suggestedFileName,
                  groupName: bestGroup.name,
                },
              };
            }
          }
        } catch (e) {
          // Fall through to graph-based analysis
        }
      }
    }
  }

  // Priority 3: Use graph insights for smart splitting
  // The graph tells us which functions form cohesive groups
  if (options.aggressive && diagnosis.graphInsights?.extractionCandidates.length) {
    for (const candidate of diagnosis.graphInsights.extractionCandidates) {
      const alreadyTried = previousActions.some(
        (a: FixAction) => a.type === 'split' && a.target === candidate.file
      );

      if (!alreadyTried && candidate.functions.length >= 2) {
        return {
          type: 'split',
          reason: `Extract cohesive group from ${candidate.file} (${candidate.functions.length} related functions, cohesion score: ${candidate.score.toFixed(2)})`,
          target: candidate.file,
          details: {
            functions: candidate.functions,
            score: candidate.score,
            graphBased: true,
          },
        };
      }
    }
  }

  // Priority 4: Traditional file size check (fallback)
  const largeFileProblems = diagnosis.problems
    .filter(p => p.category === 'file-size' && p.severity === 'critical')
    .sort((a, b) => {
      const aLines = parseInt(a.message) || 0;
      const bLines = parseInt(b.message) || 0;
      return bLines - aLines;
    });

  if (largeFileProblems.length > 0 && options.aggressive) {
    const largest = largeFileProblems[0];
    const alreadyTried = previousActions.some(
      a => a.type === 'split' && a.target === largest.file
    );

    if (!alreadyTried && largest.file) {
      return {
        type: 'split',
        reason: `Split ${largest.file} (${largest.message})`,
        target: largest.file,
        details: { lines: parseInt(largest.message) },
      };
    }
  }

  // Priority 4: Consider merging tightly coupled files
  if (options.aggressive && diagnosis.graphInsights?.tightlyCoupledFiles.length) {
    for (const couple of diagnosis.graphInsights.tightlyCoupledFiles) {
      if (couple.edges >= 8) { // Very high coupling
        const alreadyTried = previousActions.some(
          a => a.type === 'merge' &&
               (a.details?.sources as string[] | undefined)?.includes(couple.files[0])
        );

        if (!alreadyTried) {
          return {
            type: 'merge',
            reason: `Merge tightly coupled files: ${couple.files.join(' + ')} (${couple.edges} cross-file calls)`,
            details: {
              sources: couple.files,
              target: couple.files[0], // Merge into first file
              edgeCount: couple.edges,
              graphBased: true,
            },
          };
        }
      }
    }
  }

  // If we have AI configured, ask it for suggestions with graph context
  if (hasGlobalApiKey() && diagnosis.problems.length > 0) {
    try {
      const aiAction = await getAIDecision(diagnosis, previousActions);
      if (aiAction) return aiAction;
    } catch {
      // Fall through to default behavior
    }
  }

  // No more safe actions to take
  return {
    type: 'skip',
    reason: diagnosis.problems.length > 0
      ? 'Remaining issues require manual intervention'
      : 'No issues found',
  };
}

/**
 * Ask AI for refactoring decision
 */
async function getAIDecision(
  diagnosis: DiagnosisResult,
  previousActions: FixAction[]
): Promise<FixAction | null> {
  const apiKey = getGlobalApiKey();
  if (!apiKey) return null;

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

  // Build graph insights section
  let graphSection = '';
  if (diagnosis.graphInsights) {
    const gi = diagnosis.graphInsights;
    graphSection = `
GRAPH ANALYSIS:
- Hub functions (high connectivity): ${gi.hubs.slice(0, 5).map(h => `${h.name} in ${h.file} (${h.connections} connections)`).join(', ') || 'None'}
- Tightly coupled files: ${gi.tightlyCoupledFiles.slice(0, 3).map(c => `${c.files.join(' <-> ')} (${c.edges} edges)`).join(', ') || 'None'}
- Extraction candidates: ${gi.extractionCandidates.slice(0, 3).map(e => `${e.file}: [${e.functions.slice(0, 3).join(', ')}${e.functions.length > 3 ? '...' : ''}] (score: ${e.score.toFixed(2)})`).join('; ') || 'None'}
- Isolated functions (potential dead code): ${gi.isolatedFunctions.slice(0, 5).join(', ') || 'None'}
- Longest dependency chains: ${gi.criticalPaths.slice(0, 3).map(p => `${p.from} -> ... -> ${p.to} (${p.length} hops)`).join(', ') || 'None'}
`;
  }

  const prompt = `You are a code refactoring assistant. Based on the diagnosis and GRAPH ANALYSIS below, decide the next safe refactoring action.

DIAGNOSIS:
- Score: ${diagnosis.score}/100
- Total files: ${diagnosis.stats.totalFiles}
- Total functions: ${diagnosis.stats.totalFunctions}
- Unused exports: ${diagnosis.stats.unusedExports}
- Largest file: ${diagnosis.stats.largestFile.path} (${diagnosis.stats.largestFile.lines} lines)
${graphSection}
PROBLEMS (top 10):
${diagnosis.problems.slice(0, 10).map(p => `- [${p.severity}] ${p.file || 'project'}: ${p.message}`).join('\n')}

PREVIOUS ACTIONS TAKEN:
${previousActions.length > 0 ? previousActions.map(a => `- ${a.type}: ${a.reason}`).join('\n') : 'None'}

DECISION GUIDELINES:
1. Use the GRAPH ANALYSIS to make informed decisions
2. Hub functions are critical - be careful when modifying code they depend on
3. Extraction candidates with high scores are good split targets (cohesive internal calls, few external deps)
4. Tightly coupled files with many edges might benefit from merging
5. Isolated functions are likely dead code

AVAILABLE ACTIONS:
1. cleanup - Remove unused exports (always safe)
2. split - Extract functions from a file (use extraction candidates from graph!)
3. merge - Combine tightly coupled files
4. skip - No safe action available

Respond with JSON only:
{
  "action": "cleanup" | "split" | "merge" | "skip",
  "reason": "brief explanation referencing graph analysis",
  "target": "file path if split",
  "functions": ["list", "of", "functions"], // if split - prefer graph extraction candidates
  "sources": ["file1", "file2"], // if merge
  "mergeTarget": "target file" // if merge
}`;

  try {
    const response = await model.generateContent(prompt);
    const result = response.response;
    const text = result.text()?.trim() || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const decision = JSON.parse(jsonMatch[0]);

    // Build details based on action type
    let details: Record<string, unknown> | undefined;
    if (decision.action === 'split' && decision.functions) {
      details = { functions: decision.functions, aiSuggested: true };
    } else if (decision.action === 'merge' && decision.sources) {
      details = {
        sources: decision.sources,
        target: decision.mergeTarget || decision.sources[0],
        aiSuggested: true,
      };
    }

    return {
      type: decision.action || 'skip',
      reason: decision.reason || 'AI decision',
      target: decision.target,
      details,
    };
  } catch {
    return null;
  }
}

/**
 * Apply a fix action with change tracking
 */
async function applyActionWithTracking(
  action: FixAction,
  options: AutoFixOptions,
  diagnosis: DiagnosisResult
): Promise<ActionResult> {
  const rootDir = process.cwd();
  const filesModified: string[] = [];
  let linesChanged = 0;

  // Capture file states before action
  const fileStatesBefore = new Map<string, string>();

  try {
    switch (action.type) {
      case 'cleanup': {
        // Get all source files to track changes
        const graphAnalyzer = createGraphAnalyzer();
        const graph = await graphAnalyzer.buildGraph();

        for (const file of graph.files) {
          const filePath = path.join(rootDir, file);
          if (fs.existsSync(filePath)) {
            fileStatesBefore.set(file, fs.readFileSync(filePath, 'utf-8'));
          }
        }

        const result = await cleanup({
          removeUnused: true,
          dryRun: false,
        });

        if (!result.success) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: result.errors.join('; ')
          };
        }

        // Track actual changes
        for (const [file, originalContent] of fileStatesBefore) {
          const filePath = path.join(rootDir, file);
          if (fs.existsSync(filePath)) {
            const newContent = fs.readFileSync(filePath, 'utf-8');
            if (newContent !== originalContent) {
              filesModified.push(file);
              linesChanged += countLinesChanged(originalContent, newContent);
            }
          } else {
            // File was deleted
            filesModified.push(file);
            linesChanged += originalContent.split('\n').length;
          }
        }

        break;
      }

      case 'split': {
        if (!action.target) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: 'Split action requires a target file'
          };
        }

        // Get functions to extract - prefer from graph insights
        let functions = action.details?.functions as string[] | undefined;

        // If functions come from graph-based extraction candidates, use them
        if (!functions && action.details?.graphBased && diagnosis.graphInsights) {
          const candidate = diagnosis.graphInsights.extractionCandidates.find(
            c => c.file === action.target
          );
          if (candidate) {
            functions = candidate.functions;
          }
        }

        // Capture source file state
        const sourcePath = path.join(rootDir, action.target);
        if (fs.existsSync(sourcePath)) {
          fileStatesBefore.set(action.target, fs.readFileSync(sourcePath, 'utf-8'));
        }

        // Generate target filename - use semantic suggestion if available
        let targetName = action.target.replace(/\.ts$/, '-helpers.ts');
        const sourceContent = fileStatesBefore.get(action.target) || '';
        const sourceDir = path.dirname(action.target);

        // If semantic analysis already provided a filename, use it
        if (action.details?.semanticBased && action.details?.suggestedFileName) {
          targetName = path.join(sourceDir, action.details.suggestedFileName as string);
          if (options.verbose) {
            console.log(`  Semantic suggests: ${action.details.suggestedFileName} (${action.details.groupName})`);
          }
        } else if (functions && functions.length > 0) {
          const apiKey = getGlobalApiKey();
          if (apiKey) {
            try {
              // Get function contents for context
              const parsed = parseSourceFile(sourcePath, sourceContent);
              const functionContents = functions.map(name => {
                const func = parsed.functions.find((f: { name: string; content: string }) => f.name === name);
                return func?.content || '';
              });

              const gemini = createGeminiClient(apiKey);
              const suggestedName = await gemini.suggestFileName(
                functions,
                action.target,
                functionContents
              );

              targetName = path.join(sourceDir, suggestedName);

              if (options.verbose) {
                console.log(`  Gemini suggests: ${suggestedName}`);
              }
            } catch {
              // Fallback to simple naming
              const firstFunc = functions[0];
              if (firstFunc && firstFunc.length > 3) {
                targetName = action.target.replace(/\.ts$/, `-${firstFunc.toLowerCase()}.ts`);
              }
            }
          } else {
            // No API key - use simple naming
            const firstFunc = functions[0];
            if (firstFunc && firstFunc.length > 3) {
              targetName = action.target.replace(/\.ts$/, `-${firstFunc.toLowerCase()}.ts`);
            }
          }
        }

        // FIRST: Do a dry run to check quality BEFORE writing files
        const dryRunResult: SplitResult = await splitFile({
          source: action.target,
          target: targetName,
          functions,
          auto: !functions || functions.length === 0,
          dryRun: true,
        });

        if (!dryRunResult.success) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: dryRunResult.errors?.join('; ') || 'Split failed'
          };
        }

        // Quality check: Verify the split actually improves code structure BEFORE writing
        if (dryRunResult.extractedFunctions.length > 0 && dryRunResult.preview) {
          const sourceLines = sourceContent.split('\n').length;
          const newSourceLines = dryRunResult.preview.sourceContent.split('\n').length;
          const targetLines = dryRunResult.preview.targetContent.split('\n').length;

          // Check 1: Source file should shrink significantly (at least 50 lines)
          const sourceShrinkage = sourceLines - newSourceLines;
          if (sourceShrinkage < 50) {
            if (options.verbose) {
              console.log(`  Quality check failed: Source only shrunk by ${sourceShrinkage} lines (need 50+)`);
            }
            return {
              success: false,
              filesModified: [],
              linesChanged: 0,
              error: 'Split did not meaningfully reduce source file size'
            };
          }

          // Check 2: CRITICAL - Source file must NOT become a proxy (mostly imports/re-exports)
          const sourceImportLines = (dryRunResult.preview.sourceContent.match(/^import\s/gm) || []).length;
          const sourceReExportLines = (dryRunResult.preview.sourceContent.match(/^export\s*\{[^}]+\}\s*from/gm) || []).length;
          const sourceBoilerplate = sourceImportLines + sourceReExportLines;
          const sourceCodeLines = newSourceLines - sourceBoilerplate;

          // If source would have less than 40% actual code, it's becoming a useless proxy
          if (newSourceLines > 20 && sourceCodeLines / newSourceLines < 0.4) {
            if (options.verbose) {
              console.log(`  Quality check failed: Source would become proxy file (${sourceCodeLines} code lines, ${sourceBoilerplate} boilerplate out of ${newSourceLines} total)`);
            }
            return {
              success: false,
              filesModified: [],
              linesChanged: 0,
              error: 'Split would turn source into a useless proxy file'
            };
          }

          // Check 3: Target file must have substantial code (at least 100 lines)
          const targetImportLines = (dryRunResult.preview.targetContent.match(/^import\s/gm) || []).length;
          const targetExportLines = (dryRunResult.preview.targetContent.match(/^export\s*\{/gm) || []).length;
          const targetBoilerplate = targetImportLines + targetExportLines;
          const targetCodeLines = targetLines - targetBoilerplate;

          if (targetCodeLines < 100) {
            if (options.verbose) {
              console.log(`  Quality check failed: Target too small (${targetCodeLines} code lines, need 100+)`);
            }
            return {
              success: false,
              filesModified: [],
              linesChanged: 0,
              error: 'Split would create target file that is too small'
            };
          }

          // Check 4: BOTH files must have substantial code after split
          if (sourceCodeLines < 100) {
            if (options.verbose) {
              console.log(`  Quality check failed: Source too small after split (${sourceCodeLines} code lines, need 100+)`);
            }
            return {
              success: false,
              filesModified: [],
              linesChanged: 0,
              error: 'Split would leave source file too small'
            };
          }

          if (options.verbose) {
            console.log(`  Quality passed: ${sourceCodeLines} + ${targetCodeLines} code lines`);
          }
        }

        // Quality checks passed - now do the actual split
        const result: SplitResult = await splitFile({
          source: action.target,
          target: targetName,
          functions,
          auto: !functions || functions.length === 0,
          dryRun: false,
        });

        if (!result.success) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: result.errors?.join('; ') || 'Split failed'
          };
        }

        // Validate the rewrite with Gemini if API key available
        if (result.extractedFunctions.length > 0) {
          const apiKey = getGlobalApiKey();
          if (apiKey && result.preview) {
            try {
              const gemini = createGeminiClient(apiKey);
              const validation = await gemini.validateRewrite(
                sourceContent,
                result.preview.sourceContent,
                { filePath: action.target, operation: 'split' }
              );

              if (!validation.isValid && validation.confidence > 0.7) {
                // High confidence that something is wrong - abort
                if (options.verbose) {
                  console.log(`  Validation failed: ${validation.issues.join(', ')}`);
                }
                return {
                  success: false,
                  filesModified: [],
                  linesChanged: 0,
                  error: `Validation failed: ${validation.issues[0] || 'Unknown issue'}`
                };
              }

              if (validation.issues.length > 0 && options.verbose) {
                console.log(`  Validation warnings: ${validation.issues.join(', ')}`);
              }
            } catch {
              // Validation failed but continue - build verification will catch real issues
            }
          }

          // Track changes
          filesModified.push(result.sourceFile);
          filesModified.push(result.targetFile);
          filesModified.push(...result.updatedFiles);

          // Calculate lines changed
          const originalSource = fileStatesBefore.get(action.target) || '';
          const newSourcePath = path.join(rootDir, result.sourceFile);
          const newSource = fs.existsSync(newSourcePath) ? fs.readFileSync(newSourcePath, 'utf-8') : '';
          linesChanged += countLinesChanged(originalSource, newSource);

          // Count lines in new target file
          const targetPath = path.join(rootDir, result.targetFile);
          if (fs.existsSync(targetPath)) {
            linesChanged += fs.readFileSync(targetPath, 'utf-8').split('\n').length;
          }
        }

        break;
      }

      case 'merge': {
        if (!action.details?.sources || !action.details?.target) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: 'Merge action requires sources and target'
          };
        }

        const sources = action.details.sources as string[];
        const target = action.details.target as string;

        // Capture source files
        for (const source of sources) {
          const sourcePath = path.join(rootDir, source);
          if (fs.existsSync(sourcePath)) {
            fileStatesBefore.set(source, fs.readFileSync(sourcePath, 'utf-8'));
          }
        }

        const result = await mergeFiles({
          sources,
          target,
          dryRun: false,
        });

        if (!result.success) {
          return {
            success: false,
            filesModified: [],
            linesChanged: 0,
            error: result.errors?.join('; ') || 'Merge failed'
          };
        }

        // Track changes
        filesModified.push(target);
        for (const source of sources) {
          if (source !== target) {
            filesModified.push(source);
            const original = fileStatesBefore.get(source) || '';
            linesChanged += original.split('\n').length;
          }
        }

        break;
      }

      case 'skip':
        return {
          success: true,
          filesModified: [],
          linesChanged: 0
        };

      default:
        return {
          success: false,
          filesModified: [],
          linesChanged: 0,
          error: `Unknown action type: ${action.type}`
        };
    }

    return {
      success: true,
      filesModified,
      linesChanged
    };

  } catch (error) {
    return {
      success: false,
      filesModified: [],
      linesChanged: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
