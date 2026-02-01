import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createGraphAnalyzer, FunctionGraph } from '../../graph/index.js';
import { createGeminiClient } from '../../core/gemini.js';
import { getGlobalApiKey } from '../../commands/config.js';
import { SplitPreview } from '../types.js';

interface SplitOptions {
  /** File to split */
  source: string;
  /** New file for extracted code */
  target: string;
  /** Specific functions to extract */
  functions?: string[];
  /** Use AI to decide what to extract */
  auto?: boolean;
  /** Preview changes without writing */
  dryRun?: boolean;
  /** Skip confirmation prompt (for automated use) */
  skipConfirmation?: boolean;
}

interface SplitResult {
  success: boolean;
  sourceFile: string;
  targetFile: string;
  extractedFunctions: string[];
  addedImports: string[];
  reExports: string[];
  updatedFiles: string[];
  errors?: string[];
  preview?: SplitPreview;
}

interface FunctionInfo {
  name: string;
  fullName: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isPure: boolean;
  dependencies: string[];
  dependents: string[];
  content: string;
  leadingComments: string;
}

interface TypeDefinition {
  name: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  content: string;
  leadingComments: string;
  kind: 'interface' | 'type' | 'enum';
}

interface ParsedFile {
  imports: ImportInfo[];
  functions: FunctionInfo[];
  types: TypeDefinition[];
  otherContent: string[];
  sourceFile: ts.SourceFile;
}

interface ImportInfo {
  names: string[];
  source: string;
  isDefault: boolean;
  isNamespace: boolean;
  line: number;
  text: string;
}

/**
 * Split a file by extracting specified functions to a new file
 */
export async function splitFile(options: SplitOptions): Promise<SplitResult> {
  const errors: string[] = [];
  const rootDir = process.cwd();

  // Resolve paths
  const sourcePath = path.resolve(rootDir, options.source);
  const targetPath = path.resolve(rootDir, options.target);
  const sourceRelative = path.relative(rootDir, sourcePath);
  const targetRelative = path.relative(rootDir, targetPath);

  // Validate source file exists
  if (!fs.existsSync(sourcePath)) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: [`Source file not found: ${options.source}`],
    };
  }

  // Validate target doesn't exist
  if (fs.existsSync(targetPath) && !options.dryRun) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: [`Target file already exists: ${options.target}`],
    };
  }

  const sourceContent = fs.readFileSync(sourcePath, 'utf-8');

  // Build function graph for analysis
  const graphAnalyzer = createGraphAnalyzer(rootDir);
  let graph: FunctionGraph;
  try {
    graph = await graphAnalyzer.buildGraph();
  } catch (error) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: [`Failed to build function graph: ${error}`],
    };
  }

  // Parse the source file
  const parsed = parseSourceFile(sourcePath, sourceContent);

  // Determine which functions to extract
  let functionsToExtract: string[];
  if (options.auto) {
    functionsToExtract = await determineAutoExtract(
      parsed,
      graph,
      sourceRelative,
      sourceContent
    );
  } else if (options.functions && options.functions.length > 0) {
    functionsToExtract = options.functions;
  } else {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: ['No functions specified. Use --functions or --auto'],
    };
  }

  if (functionsToExtract.length === 0) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: ['No suitable functions found to extract'],
    };
  }

  // Validate all specified functions exist
  const availableFunctions = parsed.functions.map((f) => f.name);
  const missingFunctions = functionsToExtract.filter(
    (f) => !availableFunctions.includes(f)
  );
  if (missingFunctions.length > 0) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: [],
      addedImports: [],
      reExports: [],
      updatedFiles: [],
      errors: [`Functions not found: ${missingFunctions.join(', ')}`],
    };
  }

  // Resolve dependencies - if A calls B, must extract B too
  const resolvedFunctions = resolveDependencies(
    functionsToExtract,
    parsed.functions,
    graph,
    sourceRelative
  );

  // Check for unresolvable dependencies (function calls something outside this file)
  const externalDeps = findExternalDependencies(
    resolvedFunctions,
    parsed.functions,
    graph,
    sourceRelative
  );

  // Get functions to extract
  const extractedFuncs = parsed.functions.filter((f) =>
    resolvedFunctions.includes(f.name)
  );

  // Build the new target file content
  const targetContent = buildTargetFile(
    extractedFuncs,
    parsed,
    externalDeps,
    sourceContent
  );

  // Build updated source file content
  const { newSourceContent, addedImports, reExports } = buildUpdatedSource(
    parsed,
    extractedFuncs,
    sourceRelative,
    targetRelative,
    sourceContent
  );

  // Find external files that import extracted functions and update them
  const externalUpdates = await findAndUpdateExternalImports(
    graph,
    sourceRelative,
    targetRelative,
    resolvedFunctions,
    rootDir
  );

  const preview: SplitPreview = {
    sourceContent: newSourceContent,
    targetContent,
    externalUpdates,
  };

  // If dry run, return preview without writing
  if (options.dryRun) {
    return {
      success: true,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: resolvedFunctions,
      addedImports,
      reExports,
      updatedFiles: Array.from(externalUpdates.keys()),
      preview,
    };
  }

  // Write files
  try {
    // Create target directory if needed
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Write target file
    fs.writeFileSync(targetPath, targetContent);

    // Write updated source file
    fs.writeFileSync(sourcePath, newSourceContent);

    // Update external files
    for (const [filePath, content] of externalUpdates) {
      fs.writeFileSync(path.join(rootDir, filePath), content);
    }

    return {
      success: true,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: resolvedFunctions,
      addedImports,
      reExports,
      updatedFiles: Array.from(externalUpdates.keys()),
    };
  } catch (error) {
    return {
      success: false,
      sourceFile: sourceRelative,
      targetFile: targetRelative,
      extractedFunctions: resolvedFunctions,
      addedImports,
      reExports,
      updatedFiles: [],
      errors: [`Failed to write files: ${error}`],
    };
  }
}

/**
 * Parse a TypeScript/JavaScript source file to extract function info
 */
export function parseSourceFile(filePath: string, content: string): ParsedFile {
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const imports: ImportInfo[] = [];
  const functions: FunctionInfo[] = [];
  const types: TypeDefinition[] = [];
  const lines = content.split('\n');

  const visit = (node: ts.Node) => {
    // Handle imports
    if (ts.isImportDeclaration(node)) {
      const importInfo = parseImportDeclaration(node, sourceFile);
      if (importInfo) {
        imports.push(importInfo);
      }
    }

    // Handle function declarations
    if (ts.isFunctionDeclaration(node) && node.name) {
      const funcInfo = parseFunctionDeclaration(node, sourceFile, lines);
      if (funcInfo) {
        functions.push(funcInfo);
      }
    }

    // Handle arrow functions assigned to const/let
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          const funcInfo = parseVariableFunction(
            node,
            decl,
            sourceFile,
            lines
          );
          if (funcInfo) {
            functions.push(funcInfo);
          }
        }
      }
    }

    // Handle interface declarations
    if (ts.isInterfaceDeclaration(node)) {
      const typeInfo = parseTypeDefinition(node, sourceFile, 'interface');
      if (typeInfo) {
        types.push(typeInfo);
      }
    }

    // Handle type alias declarations
    if (ts.isTypeAliasDeclaration(node)) {
      const typeInfo = parseTypeDefinition(node, sourceFile, 'type');
      if (typeInfo) {
        types.push(typeInfo);
      }
    }

    // Handle enum declarations
    if (ts.isEnumDeclaration(node)) {
      const typeInfo = parseTypeDefinition(node, sourceFile, 'enum');
      if (typeInfo) {
        types.push(typeInfo);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return { imports, functions, types, otherContent: [], sourceFile };
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs'))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseImportDeclaration(
  node: ts.ImportDeclaration,
  sourceFile: ts.SourceFile
): ImportInfo | null {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return null;

  const source = node.moduleSpecifier.text;
  const line =
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const names: string[] = [];
  let isDefault = false;
  let isNamespace = false;

  const clause = node.importClause;
  if (clause) {
    if (clause.name) {
      names.push(clause.name.text);
      isDefault = true;
    }
    if (clause.namedBindings) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          names.push(el.name.text);
        }
      } else if (ts.isNamespaceImport(clause.namedBindings)) {
        names.push(clause.namedBindings.name.text);
        isNamespace = true;
      }
    }
  }

  return {
    names,
    source,
    isDefault,
    isNamespace,
    line,
    text: node.getText(sourceFile),
  };
}

function parseFunctionDeclaration(
  node: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
  lines: string[]
): FunctionInfo | null {
  if (!node.name) return null;

  const name = node.name.text;
  const startLine =
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const endLine =
    sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const isExported = hasExportModifier(node);

  // Get leading comments
  const leadingComments = getLeadingComments(node, sourceFile);

  // Get function content
  const content = node.getText(sourceFile);

  // Find function calls within this function
  const dependencies = findFunctionCalls(node, sourceFile);

  return {
    name,
    fullName: name,
    startLine,
    endLine,
    isExported,
    isPure: true, // Will be determined by graph analysis
    dependencies,
    dependents: [],
    content,
    leadingComments,
  };
}

function parseVariableFunction(
  statement: ts.VariableStatement,
  decl: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
  lines: string[]
): FunctionInfo | null {
  if (!ts.isIdentifier(decl.name)) return null;

  const name = decl.name.text;
  const startLine =
    sourceFile.getLineAndCharacterOfPosition(statement.getStart()).line + 1;
  const endLine =
    sourceFile.getLineAndCharacterOfPosition(statement.getEnd()).line + 1;
  const isExported = hasExportModifier(statement);

  // Get leading comments
  const leadingComments = getLeadingComments(statement, sourceFile);

  // Get full statement content
  const content = statement.getText(sourceFile);

  // Find function calls
  const dependencies = findFunctionCalls(decl.initializer!, sourceFile);

  return {
    name,
    fullName: name,
    startLine,
    endLine,
    isExported,
    isPure: true,
    dependencies,
    dependents: [],
    content,
    leadingComments,
  };
}

function parseTypeDefinition(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
  kind: 'interface' | 'type' | 'enum'
): TypeDefinition | null {
  const name = node.name.text;
  const startLine =
    sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const endLine =
    sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const isExported = hasExportModifier(node);
  const leadingComments = getLeadingComments(node, sourceFile);
  const content = node.getText(sourceFile);

  return {
    name,
    startLine,
    endLine,
    isExported,
    content,
    leadingComments,
    kind,
  };
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ===
      true
  );
}

function getLeadingComments(
  node: ts.Node,
  sourceFile: ts.SourceFile
): string {
  const fullText = sourceFile.getFullText();
  const nodeStart = node.getFullStart();
  const leadingTrivia = fullText.slice(nodeStart, node.getStart());

  // Extract JSDoc and line comments
  const comments: string[] = [];
  const commentRegex = /\/\*\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  let match;
  while ((match = commentRegex.exec(leadingTrivia)) !== null) {
    comments.push(match[0]);
  }

  return comments.join('\n');
}

function findFunctionCalls(
  node: ts.Node,
  sourceFile: ts.SourceFile
): string[] {
  const calls: string[] = [];

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      calls.push(n.expression.text);
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return [...new Set(calls)];
}

/**
 * Use AI to determine which functions to extract
 */
async function determineAutoExtract(
  parsed: ParsedFile,
  graph: FunctionGraph,
  sourceFile: string,
  content: string
): Promise<string[]> {
  // Criteria for auto-extract:
  // 1. Pure functions (no side effects)
  // 2. Internal helpers (not exported, only used within this file)
  // 3. Functions that form a cohesive group

  const candidates: string[] = [];

  for (const func of parsed.functions) {
    const funcId = `${sourceFile}:${func.name}`;
    const node = graph.nodes.get(funcId);

    if (!node) continue;

    // Check if function is pure
    const isPure = node.purity === 'pure';

    // Check if only used within this file
    const usedExternally = graph.edges.some(
      (edge) => edge.to === funcId && !edge.from.startsWith(sourceFile + ':')
    );

    // Not exported or only used internally
    const isInternalHelper = !func.isExported || !usedExternally;

    if (isPure && isInternalHelper) {
      candidates.push(func.name);
    }
  }

  // If no candidates from heuristics, try AI suggestion
  if (candidates.length === 0) {
    const apiKey = getGlobalApiKey();
    if (apiKey) {
      try {
        const gemini = createGeminiClient(apiKey);
        const suggestions = await getAISplitSuggestions(
          gemini,
          sourceFile,
          content,
          parsed.functions
        );
        return suggestions;
      } catch {
        // Fall back to empty if AI fails
      }
    }
  }

  return candidates;
}

async function getAISplitSuggestions(
  gemini: ReturnType<typeof createGeminiClient>,
  filePath: string,
  content: string,
  functions: FunctionInfo[]
): Promise<string[]> {
  // This would call the AI to get suggestions
  // For now, return functions that appear to be utility helpers
  const utilityPatterns = [
    /^(is|has|get|set|make|create|parse|format|validate|convert|transform)/,
    /Helper$/,
    /Util$/,
  ];

  return functions
    .filter((f) => {
      const isUtility = utilityPatterns.some((p) => p.test(f.name));
      const isSmall =
        f.endLine - f.startLine < 30; // Less than 30 lines
      return isUtility && isSmall && !f.isExported;
    })
    .map((f) => f.name);
}

/**
 * Check if a function is nested (closure) based on graph info
 */
function isNestedFunction(funcName: string, sourceFile: string, graph: FunctionGraph): boolean {
  const funcId = `${sourceFile}:${funcName}`;
  const node = graph.nodes.get(funcId);
  return node?.isNested ?? false;
}

/**
 * Resolve function dependencies - if extracting A which calls B, must extract B too
 */
function resolveDependencies(
  initialFunctions: string[],
  allFunctions: FunctionInfo[],
  graph: FunctionGraph,
  sourceFile: string
): string[] {
  const toExtract = new Set(initialFunctions);
  // Only consider top-level (non-nested) functions as extractable
  const functionNames = new Set(
    allFunctions
      .filter(f => !isNestedFunction(f.name, sourceFile, graph))
      .map((f) => f.name)
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const funcName of toExtract) {
      const func = allFunctions.find((f) => f.name === funcName);
      if (!func) continue;

      // Check dependencies from parsed function
      for (const dep of func.dependencies) {
        // Only include if it's a top-level function in this file (not nested)
        if (functionNames.has(dep) && !toExtract.has(dep)) {
          toExtract.add(dep);
          changed = true;
        }
      }

      // Also check graph edges
      const funcId = `${sourceFile}:${funcName}`;
      for (const edge of graph.edges) {
        if (edge.from === funcId) {
          const toName = edge.to.split(':').pop()!;
          if (
            edge.to.startsWith(sourceFile + ':') &&
            functionNames.has(toName) &&
            !toExtract.has(toName)
          ) {
            toExtract.add(toName);
            changed = true;
          }
        }
      }
    }
  }

  return Array.from(toExtract);
}

/**
 * Find external dependencies that extracted functions need
 */
function findExternalDependencies(
  extractedFunctions: string[],
  allFunctions: FunctionInfo[],
  graph: FunctionGraph,
  sourceFile: string
): Set<string> {
  const externalDeps = new Set<string>();

  for (const funcName of extractedFunctions) {
    const funcId = `${sourceFile}:${funcName}`;

    for (const edge of graph.edges) {
      if (edge.from === funcId && !edge.to.startsWith(sourceFile + ':')) {
        // This is an external dependency
        externalDeps.add(edge.to);
      }
    }
  }

  return externalDeps;
}

/**
 * Determine which type definitions from the source file are needed by extracted functions
 */
function determineNeededTypes(
  functions: FunctionInfo[],
  parsed: ParsedFile
): TypeDefinition[] {
  // Collect all identifiers used in extracted functions
  const usedIdentifiers = new Set<string>();
  for (const func of functions) {
    const identifiers = extractIdentifiers(func.content);
    identifiers.forEach((id) => usedIdentifiers.add(id));
  }

  // Find types that are used
  const neededTypes: TypeDefinition[] = [];
  const typeNames = new Set<string>();

  for (const typeDef of parsed.types) {
    if (usedIdentifiers.has(typeDef.name) && !typeNames.has(typeDef.name)) {
      neededTypes.push(typeDef);
      typeNames.add(typeDef.name);

      // Also check if this type references other types
      const typeIdentifiers = extractIdentifiers(typeDef.content);
      for (const otherType of parsed.types) {
        if (typeIdentifiers.has(otherType.name) && !typeNames.has(otherType.name)) {
          neededTypes.push(otherType);
          typeNames.add(otherType.name);
        }
      }
    }
  }

  // Sort types by their line number to preserve definition order
  return neededTypes.sort((a, b) => a.startLine - b.startLine);
}

/**
 * Build the content for the new target file
 */
function buildTargetFile(
  functions: FunctionInfo[],
  parsed: ParsedFile,
  externalDeps: Set<string>,
  sourceContent: string
): string {
  const lines: string[] = [];

  // Determine which type definitions need to be included
  const neededTypes = determineNeededTypes(functions, parsed);

  // Determine which imports are needed - include both function and type dependencies
  const neededImports = determineNeededImportsWithTypes(functions, neededTypes, parsed, sourceContent);

  // Add imports
  for (const imp of neededImports) {
    lines.push(imp);
  }

  if (neededImports.length > 0) {
    lines.push('');
  }

  // Add type definitions
  for (const typeDef of neededTypes) {
    if (typeDef.leadingComments) {
      lines.push(typeDef.leadingComments);
    }
    lines.push(typeDef.content);
    lines.push('');
  }

  // Add functions with their comments
  for (const func of functions) {
    if (func.leadingComments) {
      lines.push(func.leadingComments);
    }

    // Make sure function is exported
    let funcContent = func.content;
    if (!func.isExported) {
      // Add export keyword
      if (funcContent.startsWith('async function')) {
        funcContent = 'export ' + funcContent;
      } else if (funcContent.startsWith('function')) {
        funcContent = 'export ' + funcContent;
      } else if (funcContent.startsWith('const ') || funcContent.startsWith('let ')) {
        funcContent = 'export ' + funcContent;
      }
    }

    lines.push(funcContent);
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

/**
 * Determine which imports from source file are needed in target
 * Scans both function content AND type definitions for identifiers
 */
function determineNeededImportsWithTypes(
  functions: FunctionInfo[],
  types: TypeDefinition[],
  parsed: ParsedFile,
  sourceContent: string
): string[] {
  const neededImports: string[] = [];

  // Collect all identifiers used in extracted functions AND types
  const usedIdentifiers = new Set<string>();

  for (const func of functions) {
    const identifiers = extractIdentifiers(func.content);
    identifiers.forEach((id) => usedIdentifiers.add(id));
  }

  // Also scan type definitions for identifiers they use
  for (const typeDef of types) {
    const identifiers = extractIdentifiers(typeDef.content);
    identifiers.forEach((id) => usedIdentifiers.add(id));
  }

  // Check which imports are needed
  for (const imp of parsed.imports) {
    const neededNames = imp.names.filter((name) => usedIdentifiers.has(name));
    if (neededNames.length > 0) {
      // Preserve type-only imports (import type { ... })
      const isTypeImport = imp.text.trimStart().startsWith('import type');
      const typeKeyword = isTypeImport ? 'type ' : '';

      if (imp.isDefault) {
        neededImports.push(`import ${typeKeyword}${neededNames[0]} from '${imp.source}';`);
      } else if (imp.isNamespace) {
        neededImports.push(`import ${typeKeyword}* as ${neededNames[0]} from '${imp.source}';`);
      } else {
        neededImports.push(
          `import ${typeKeyword}{ ${neededNames.join(', ')} } from '${imp.source}';`
        );
      }
    }
  }

  return neededImports;
}
function extractIdentifiers(content: string): Set<string> {
  const identifiers = new Set<string>();
  // Simple regex to find potential identifiers
  const matches = content.match(/\b[a-zA-Z_$][a-zA-Z0-9_$]*\b/g);
  if (matches) {
    matches.forEach((m) => identifiers.add(m));
  }
  return identifiers;
}

/**
 * Build updated source file content
 */
function buildUpdatedSource(
  parsed: ParsedFile,
  extractedFuncs: FunctionInfo[],
  sourcePath: string,
  targetPath: string,
  sourceContent: string
): { newSourceContent: string; addedImports: string[]; reExports: string[] } {
  const lines = sourceContent.split('\n');
  const extractedNames = extractedFuncs.map((f) => f.name);

  // Find which extracted functions were exported (need re-export)
  const exportedExtractedFuncs = extractedFuncs.filter((f) => f.isExported);
  const exportedNames = exportedExtractedFuncs.map((f) => f.name);

  // Calculate relative import path
  const sourceDir = path.dirname(sourcePath);
  const targetDir = path.dirname(targetPath);
  let relativePath = path.relative(sourceDir, targetPath);

  // Ensure it starts with ./
  if (!relativePath.startsWith('.')) {
    relativePath = './' + relativePath;
  }
  // Remove .ts/.tsx extension and add .js for ESM compatibility
  relativePath = relativePath.replace(/\.tsx?$/, '.js');

  // Build the new import statement
  const importStatement = `import { ${extractedNames.join(', ')} } from '${relativePath}';`;

  // Build re-export statement for functions that were exported
  const reExportStatement = exportedNames.length > 0
    ? `export { ${exportedNames.join(', ')} } from '${relativePath}';`
    : '';

  // Find line ranges to remove (extracted functions)
  const linesToRemove = new Set<number>();
  for (const func of extractedFuncs) {
    // Include leading comments in removal
    let startLine = func.startLine;

    // Check for leading comments
    if (func.leadingComments) {
      const commentLines = func.leadingComments.split('\n').length;
      // Find where comments start
      for (let i = func.startLine - 2; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.startsWith('/**') || line.startsWith('//') || line.startsWith('*')) {
          startLine = i + 1;
        } else if (line === '') {
          continue;
        } else {
          break;
        }
      }
    }

    for (let i = startLine - 1; i < func.endLine; i++) {
      linesToRemove.add(i);
    }
  }

  // Build new content
  const newLines: string[] = [];
  let importAdded = false;
  let lastLineWasRemoved = false;
  let inMultiLineImport = false;
  let lastImportEndLine = -1;

  // First pass: find the last import statement end line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('import ') || line.startsWith('import{')) {
      inMultiLineImport = !line.includes(' from ') || !line.endsWith(';');
      if (!inMultiLineImport) {
        lastImportEndLine = i;
      }
    } else if (inMultiLineImport) {
      if (line.includes(' from ') || line.includes("from '") || line.includes('from "')) {
        lastImportEndLine = i;
        inMultiLineImport = false;
      }
    }
  }

  inMultiLineImport = false;

  for (let i = 0; i < lines.length; i++) {
    // Skip removed lines
    if (linesToRemove.has(i)) {
      lastLineWasRemoved = true;
      continue;
    }

    // Track multi-line imports
    const line = lines[i].trim();
    if (line.startsWith('import ') || line.startsWith('import{')) {
      inMultiLineImport = !line.includes(' from ') || !line.endsWith(';');
    } else if (inMultiLineImport) {
      if (line.includes(' from ') || line.includes("from '") || line.includes('from "')) {
        inMultiLineImport = false;
      }
    }

    // Add import and re-export after the last import statement
    if (!importAdded && i === lastImportEndLine) {
      newLines.push(lines[i]);
      newLines.push(importStatement);
      if (reExportStatement) {
        newLines.push(reExportStatement);
      }
      importAdded = true;
      continue;
    }

    // If no imports exist, add at the top (after any comments/pragma)
    if (!importAdded && lastImportEndLine === -1) {
      if (
        i === 0 &&
        !line.startsWith('import ') &&
        !line.startsWith('//') &&
        !line.startsWith('/*') &&
        !line.startsWith("'use") &&
        !line.startsWith('"use')
      ) {
        newLines.push(importStatement);
        if (reExportStatement) {
          newLines.push(reExportStatement);
        }
        newLines.push('');
        importAdded = true;
      }
    }

    // Don't add extra blank lines where functions were removed
    if (lastLineWasRemoved && lines[i].trim() === '' && newLines[newLines.length - 1]?.trim() === '') {
      lastLineWasRemoved = false;
      continue;
    }

    lastLineWasRemoved = false;
    newLines.push(lines[i]);
  }

  // If import still not added (file had no imports), add at beginning
  if (!importAdded) {
    newLines.unshift('');
    if (reExportStatement) {
      newLines.unshift(reExportStatement);
    }
    newLines.unshift(importStatement);
  }

  const reExports = reExportStatement ? [reExportStatement] : [];

  return {
    newSourceContent: newLines.join('\n'),
    addedImports: [importStatement],
    reExports,
  };
}

/**
 * Find and update external files that import the extracted functions
 */
async function findAndUpdateExternalImports(
  graph: FunctionGraph,
  sourceFile: string,
  targetFile: string,
  extractedFunctions: string[],
  rootDir: string
): Promise<Map<string, string>> {
  const updates = new Map<string, string>();

  // Find all files that import from source
  const importingFiles = new Set<string>();

  for (const file of graph.files) {
    if (file === sourceFile) continue;

    const filePath = path.join(rootDir, file);
    if (!fs.existsSync(filePath)) continue;

    const content = fs.readFileSync(filePath, 'utf-8');

    // Check if file imports from source
    const sourceBaseName = path.basename(sourceFile).replace(/\.[^.]+$/, '');
    const importRegex = new RegExp(
      `import\\s+.*\\s+from\\s+['"][^'"]*${escapeRegex(sourceBaseName)}['"]`,
      'g'
    );

    if (importRegex.test(content)) {
      importingFiles.add(file);
    }
  }

  // Update each importing file
  for (const file of importingFiles) {
    const filePath = path.join(rootDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const updated = updateImportStatements(
      content,
      sourceFile,
      targetFile,
      extractedFunctions,
      file
    );

    if (updated !== content) {
      updates.set(file, updated);
    }
  }

  return updates;
}

function updateImportStatements(
  content: string,
  sourceFile: string,
  targetFile: string,
  extractedFunctions: string[],
  currentFile: string
): string {
  const lines = content.split('\n');
  const newLines: string[] = [];

  const sourceBaseName = path.basename(sourceFile).replace(/\.[^.]+$/, '');
  const extractedSet = new Set(extractedFunctions);

  // Calculate relative path from current file to target
  const currentDir = path.dirname(currentFile);
  const targetDir = path.dirname(targetFile);
  let targetRelative = path.relative(currentDir, targetFile);
  if (!targetRelative.startsWith('.')) {
    targetRelative = './' + targetRelative;
  }
  // Replace .ts/.tsx extension with .js for ESM compatibility
  targetRelative = targetRelative.replace(/\.tsx?$/, '.js');

  for (const line of lines) {
    // Check if this is an import from the source file
    const importMatch = line.match(
      /^(\s*)import\s+\{([^}]+)\}\s+from\s+['"]([^'"]*)['"]/
    );

    if (importMatch) {
      const [, indent, namesPart, importPath] = importMatch;

      if (importPath.includes(sourceBaseName)) {
        const names = namesPart.split(',').map((n) => n.trim());
        const stayingNames = names.filter((n) => !extractedSet.has(n));
        const movingNames = names.filter((n) => extractedSet.has(n));

        if (movingNames.length > 0) {
          // Add import for moved functions
          if (stayingNames.length > 0) {
            newLines.push(
              `${indent}import { ${stayingNames.join(', ')} } from '${importPath}';`
            );
          }
          newLines.push(
            `${indent}import { ${movingNames.join(', ')} } from '${targetRelative}';`
          );
          continue;
        }
      }
    }

    // Check if this is a re-export from the source file
    const reExportMatch = line.match(
      /^(\s*)export\s+\{([^}]+)\}\s+from\s+['"]([^'"]*)['"]/
    );

    if (reExportMatch) {
      const [, indent, namesPart, exportPath] = reExportMatch;

      if (exportPath.includes(sourceBaseName)) {
        const names = namesPart.split(',').map((n) => n.trim());
        const stayingNames = names.filter((n) => !extractedSet.has(n));
        const movingNames = names.filter((n) => extractedSet.has(n));

        if (movingNames.length > 0) {
          // Update re-export: split between source and target
          if (stayingNames.length > 0) {
            newLines.push(
              `${indent}export { ${stayingNames.join(', ')} } from '${exportPath}';`
            );
          }
          newLines.push(
            `${indent}export { ${movingNames.join(', ')} } from '${targetRelative}';`
          );
          continue;
        }
      }
    }

    newLines.push(line);
  }

  return newLines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Get a preview of what would be extracted
 */
export async function previewSplit(options: SplitOptions): Promise<SplitResult> {
  return splitFile({ ...options, dryRun: true });
}
