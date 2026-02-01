import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';

const SYSTEM_PROMPT = `You are Consuela, an expert code refactoring assistant. Your job is to clean up and improve code while preserving its behavior.

Your improvements should focus on:
- Improving code readability and clarity
- Removing dead code and unused variables
- Simplifying complex logic
- Improving variable names (internal only)
- Adding helpful comments where logic is complex
- Consistent formatting

CONSTRAINTS:
- Do NOT change function signatures or exported names
- Do NOT add or remove imports unless clearly dead
- Do NOT change the module's public API
- Preserve all existing behavior

Return the refactored code with a brief explanation of changes.`;

/** Validation result for rewrites */
interface ValidationResult {
  isValid: boolean;
  issues: string[];
  suggestions: string[];
  confidence: number;
}

export interface TidyContext {
  exports?: Array<{ name: string; kind: string; usageCount: number }>;
  imports?: Array<{ name: string; source: string }>;
  dependents?: string[];
  unusedExports?: string[];
}

interface SemanticGroup {
  name: string;
  description: string;
  functions: string[];
  suggestedFileName: string;
}

export interface SemanticAnalysisResult {
  groups: SemanticGroup[];
  ungrouped: string[];
  reasoning: string;
}

/** File info for reorganization analysis */
export interface FileInfoForReorg {
  path: string;
  exports: string[];
  imports: string[];
  lineCount: number;
  purpose?: string;
}

/** Dependency info for reorganization */
export interface DependencyInfoForReorg {
  file: string;
  dependsOn: string[];
  dependedOnBy: string[];
}

/** Hub file info */
export interface HubFileInfo {
  file: string;
  connections: number;
}

/** Reorganization suggestion from AI */
export interface ReorganizationSuggestion {
  domains: Array<{
    name: string;
    folder: string;
    files: Array<{
      currentPath: string;
      newPath: string;
      reason?: string;
    }>;
    description?: string;
  }>;
  barrelFiles: Array<{
    path: string;
    exports: string[];
  }>;
  reasoning: string;
}

class GeminiClient {
  private model: GenerativeModel;

  constructor(apiKey: string) {
    const genAI = new GoogleGenerativeAI(apiKey);
    // Use gemini-3-flash-preview for latest capabilities
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  async tidyCode(
    filePath: string,
    fileContent: string,
    context: TidyContext = {}
  ): Promise<{ cleanedCode: string; changes: string[]; reasoning: string }> {
    // Build context section
    let contextSection = '';

    if (context.exports && context.exports.length > 0) {
      contextSection += `\n## Exports from this file:\n`;
      for (const exp of context.exports) {
        const usage = exp.usageCount > 0 ? `(used ${exp.usageCount} times)` : '(unused)';
        contextSection += `- ${exp.name} [${exp.kind}] ${usage}\n`;
      }
    }

    if (context.unusedExports && context.unusedExports.length > 0) {
      contextSection += `\n## Unused exports (safe to remove if internal):\n`;
      for (const name of context.unusedExports) {
        contextSection += `- ${name}\n`;
      }
    }

    if (context.dependents && context.dependents.length > 0) {
      contextSection += `\n## Files that depend on this file:\n`;
      for (const dep of context.dependents.slice(0, 10)) {
        contextSection += `- ${dep}\n`;
      }
      if (context.dependents.length > 10) {
        contextSection += `- ... and ${context.dependents.length - 10} more\n`;
      }
      contextSection += `\nIMPORTANT: Be extra careful with changes since ${context.dependents.length} files depend on this.\n`;
    }

    const prompt = `${SYSTEM_PROMPT}

## File: ${filePath}
${contextSection}
## Code:

\`\`\`
${fileContent}
\`\`\`

Please refactor this code. Return your response in this exact format:

### REFACTORED_CODE_START
[Your refactored code here]
### REFACTORED_CODE_END

### CHANGES
- [List each change as a bullet point]

### REASONING
[Brief explanation]`;

    const result = await this.model.generateContent(prompt);
    const response = result.response.text();

    return this.parseResponse(response);
  }

  private parseResponse(response: string): {
    cleanedCode: string;
    changes: string[];
    reasoning: string;
  } {
    const codeMatch = response.match(
      /### REFACTORED_CODE_START\n([\s\S]*?)\n### REFACTORED_CODE_END/
    );
    const changesMatch = response.match(/### CHANGES\n([\s\S]*?)(?=\n### REASONING|$)/);
    const reasoningMatch = response.match(/### REASONING\n([\s\S]*?)$/);

    const cleanedCode = codeMatch ? codeMatch[1].trim() : '';

    const changesText = changesMatch ? changesMatch[1].trim() : '';
    const changes = changesText
      .split('\n')
      .filter((line) => line.startsWith('-'))
      .map((line) => line.substring(1).trim());

    const reasoning = reasoningMatch ? reasoningMatch[1].trim() : '';

    return { cleanedCode, changes, reasoning };
  }

  /**
   * Suggest a semantic file name based on extracted functions
   * This creates meaningful names like "string-utils.ts" instead of "split-getscriptkind.ts"
   */
  async suggestFileName(
    functions: string[],
    sourceFile: string,
    functionContents: string[]
  ): Promise<string> {
    const prompt = `You are a code organization expert. Suggest a descriptive, semantic file name for a new module that will contain these functions extracted from ${sourceFile}.

FUNCTIONS TO BE EXTRACTED:
${functions.map((name, i) => `- ${name}\n${functionContents[i]?.slice(0, 200) || '(content not available)'}...`).join('\n\n')}

REQUIREMENTS:
1. The name should describe WHAT these functions do, not HOW they do it
2. Use kebab-case (e.g., "string-utils.ts", "date-helpers.ts", "api-handlers.ts")
3. Be concise (1-3 words max)
4. Don't include words like "split", "extracted", "new"
5. Match common TypeScript/JavaScript naming conventions

Respond with ONLY the filename (with .ts extension), nothing else.
Example: date-formatters.ts`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = result.response.text().trim();

      // Validate the response is a valid filename
      const filename = response.replace(/['"]/g, '').trim();
      if (/^[a-z][a-z0-9-]*\.ts$/.test(filename)) {
        return filename;
      }

      // Fallback: use first function name
      return functions[0] ? `${functions[0].toLowerCase()}.ts` : 'helpers.ts';
    } catch {
      // Fallback on error
      return functions[0] ? `${functions[0].toLowerCase()}.ts` : 'helpers.ts';
    }
  }

  /**
   * Validate a code rewrite to ensure it preserves functionality
   * Returns validation issues and confidence score
   */
  async validateRewrite(
    originalCode: string,
    newCode: string,
    context: { filePath: string; operation: string }
  ): Promise<ValidationResult> {
    const prompt = `You are a code review expert. Analyze this code transformation and identify any issues.

OPERATION: ${context.operation}
FILE: ${context.filePath}

ORIGINAL CODE:
\`\`\`typescript
${originalCode.slice(0, 3000)}${originalCode.length > 3000 ? '\n... (truncated)' : ''}
\`\`\`

NEW CODE:
\`\`\`typescript
${newCode.slice(0, 3000)}${newCode.length > 3000 ? '\n... (truncated)' : ''}
\`\`\`

Analyze for:
1. Removed exports that might be used externally
2. Changed function signatures
3. Missing imports
4. Logic changes that could break behavior
5. Syntax errors

Respond with JSON only:
{
  "isValid": true/false,
  "issues": ["list of problems found"],
  "suggestions": ["list of improvements"],
  "confidence": 0.0-1.0
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          isValid: parsed.isValid ?? true,
          issues: parsed.issues || [],
          suggestions: parsed.suggestions || [],
          confidence: parsed.confidence ?? 0.5,
        };
      }
    } catch {
      // On parse error, assume it's fine but with low confidence
    }

    return {
      isValid: true,
      issues: [],
      suggestions: [],
      confidence: 0.3,
    };
  }

  /**
   * Analyze whether an export is safe to remove
   * Considers barrel files, re-exports, and external usage patterns
   */
  async analyzeExportSafety(
    exportName: string,
    filePath: string,
    fileContent: string,
    barrelFiles: string[]
  ): Promise<{
    safeToRemove: boolean;
    safeToMakeLocal: boolean;
    reason: string;
    confidence: number;
  }> {
    const prompt = `You are analyzing whether an export can be safely removed or made local (non-exported).

EXPORT: ${exportName}
FILE: ${filePath}

FILE CONTENT (excerpt):
\`\`\`typescript
${fileContent.slice(0, 2000)}
\`\`\`

KNOWN BARREL/INDEX FILES THAT MAY RE-EXPORT:
${barrelFiles.slice(0, 10).join('\n') || 'None found'}

ANALYSIS NEEDED:
1. Is this export used internally in the same file?
2. Is this likely re-exported by a barrel/index file?
3. Does this look like a public API (e.g., main function, component, hook)?
4. Is this a type/interface that other files might import?

Respond with JSON only:
{
  "safeToRemove": true/false,
  "safeToMakeLocal": true/false,
  "reason": "explanation",
  "confidence": 0.0-1.0
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          safeToRemove: parsed.safeToRemove ?? false,
          safeToMakeLocal: parsed.safeToMakeLocal ?? false,
          reason: parsed.reason || 'Unknown',
          confidence: parsed.confidence ?? 0.5,
        };
      }
    } catch {
      // Conservative default
    }

    return {
      safeToRemove: false,
      safeToMakeLocal: false,
      reason: 'Could not analyze',
      confidence: 0.0,
    };
  }

  async analyzeSemanticGroups(
    filePath: string,
    functions: Array<{ name: string; signature: string; lineCount: number }>,
    minGroupSize: number = 100
  ): Promise<SemanticAnalysisResult> {
    const funcList = functions.map(f =>
      `- ${f.name} (${f.lineCount} lines)\n  Signature: ${f.signature}`
    ).join('\n\n');

    const prompt = `Analyze this TypeScript file to suggest how it should be split.

FILE: ${filePath}
FUNCTIONS (${functions.length} total):
${funcList}

Group functions by semantic responsibility. Each group must have ${minGroupSize}+ lines.
IMPORTANT: Only use exact function names from the list above.

Respond with JSON only:
{
  "groups": [{"name": "Group Name", "description": "Purpose", "functions": ["func1"], "suggestedFileName": "name.ts"}],
  "ungrouped": ["other funcs"],
  "reasoning": "Why"
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const allNames = new Set(functions.map(f => f.name));
        const mentioned = new Set<string>();
        const groups: SemanticGroup[] = [];

        for (const g of (parsed.groups || [])) {
          const valid = (g.functions || []).filter((f: string) => allNames.has(f) && !mentioned.has(f));
          if (valid.length > 0) {
            valid.forEach((f: string) => mentioned.add(f));
            groups.push({
              name: g.name || 'Group',
              description: g.description || '',
              functions: valid,
              suggestedFileName: g.suggestedFileName || 'module.ts',
            });
          }
        }

        return {
          groups,
          ungrouped: functions.filter(f => !mentioned.has(f.name)).map(f => f.name),
          reasoning: parsed.reasoning || '',
        };
      }
    } catch { /* ignore */ }

    return { groups: [], ungrouped: functions.map(f => f.name), reasoning: 'Parse failed' };
  }

  /**
   * Suggest a reorganization structure for the codebase
   * Analyzes file purposes, dependencies, and suggests domain-based organization
   */
  async suggestReorganization(
    files: FileInfoForReorg[],
    dependencies: DependencyInfoForReorg[],
    hubFiles: HubFileInfo[],
    options: { aggressive?: boolean } = {}
  ): Promise<ReorganizationSuggestion> {
    const filesSection = files.map(f =>
      `- ${f.path} (${f.lineCount} lines)
   Exports: ${f.exports.slice(0, 5).join(', ')}${f.exports.length > 5 ? '...' : ''}
   Imports from: ${f.imports.slice(0, 3).join(', ')}${f.imports.length > 3 ? '...' : ''}`
    ).join('\n');

    const depsSection = dependencies.slice(0, 20).map(d =>
      `- ${d.file}: depends on [${d.dependsOn.slice(0, 3).join(', ')}], used by [${d.dependedOnBy.slice(0, 3).join(', ')}]`
    ).join('\n');

    const hubsSection = hubFiles.slice(0, 10).map(h =>
      `- ${h.file} (${h.connections} connections)`
    ).join('\n');

    const aggressiveNote = options.aggressive
      ? `\nIMPORTANT: Be aggressive with restructuring. Create clear domain boundaries even if it means many file moves. Prioritize clean architecture over minimal changes.`
      : `\nBe conservative - only suggest moves that clearly improve organization. Minimize disruption.`;

    const prompt = `You are a code organization expert. Analyze this codebase and suggest how to reorganize it into a clean, domain-driven structure.

## Current Files:
${filesSection}

## Dependency Relationships:
${depsSection}

## Hub Files (highly connected):
${hubsSection}
${aggressiveNote}

## Guidelines:
1. Group related files into domain folders (e.g., auth/, users/, api/)
2. Keep utility/shared code in common/ or shared/
3. NEVER move entry points (index.ts, main.ts, app.ts at root, package.json entries)
4. Suggest barrel files (index.ts) for each domain
5. Use semantic, kebab-case folder names
6. Consider import relationships - keep tightly coupled files together
7. New file names should be descriptive and follow kebab-case

Respond with JSON only (no markdown):
{
  "domains": [
    {
      "name": "domain-name",
      "folder": "src/domain-name",
      "description": "What this domain handles",
      "files": [
        { "currentPath": "src/old/file.ts", "newPath": "src/domain-name/file.ts", "reason": "why" }
      ]
    }
  ],
  "barrelFiles": [
    { "path": "src/domain-name/index.ts", "exports": ["export1", "export2"] }
  ],
  "reasoning": "Overall explanation of the reorganization strategy"
}`;

    try {
      const result = await this.model.generateContent(prompt);
      const text = result.response.text().trim();

      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          domains: parsed.domains || [],
          barrelFiles: parsed.barrelFiles || [],
          reasoning: parsed.reasoning || 'No reasoning provided',
        };
      }
    } catch {
      // Return empty suggestion on error
    }

    return {
      domains: [],
      barrelFiles: [],
      reasoning: 'Could not analyze codebase structure',
    };
  }
}

export const createGeminiClient = (apiKey: string): GeminiClient => {
  return new GeminiClient(apiKey);
};
