# Multi-Language Architecture

## Current State

Consuela is tightly coupled to TypeScript's compiler API (`ts.*`). The `ProjectAnalyzer` class handles both:
1. **Parsing** - Reading AST, extracting exports/imports
2. **Analysis** - Building dependency graphs, finding unused exports, detecting cycles

## Proposed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLI / Commands                          │
├─────────────────────────────────────────────────────────────┤
│                    Analysis Engine                           │
│  (circular detection, unused exports, impact, diff, tidy)   │
├─────────────────────────────────────────────────────────────┤
│                   Language Abstraction                       │
│         (common interfaces for all languages)                │
├──────────────┬──────────────┬──────────────┬────────────────┤
│  TypeScript  │    Python    │     Go       │     Rust       │
│    Parser    │    Parser    │    Parser    │    Parser      │
└──────────────┴──────────────┴──────────────┴────────────────┘
```

## Core Interfaces

```typescript
// src/core/language/types.ts

/** Language-agnostic export information */
interface Export {
  name: string;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'constant' | 'module';
  filePath: string;
  line: number;
  isDefault?: boolean;
  isReExport?: boolean;
  signature?: string;
}

/** Language-agnostic import information */
interface Import {
  name: string;
  alias?: string;
  source: string;          // The import specifier (e.g., './utils', 'lodash')
  resolvedPath?: string;   // Resolved absolute path
  filePath: string;        // File containing this import
  line: number;
  isDefault?: boolean;
}

/** Result of parsing a single file */
interface FileParseResult {
  filePath: string;
  exports: Export[];
  imports: Import[];
  symbols: Map<string, SymbolInfo>;  // Local symbol table
}

/** A language parser must implement this interface */
interface LanguageParser {
  /** File extensions this parser handles */
  extensions: string[];

  /** Parse a single file and extract exports/imports */
  parseFile(filePath: string, content: string): FileParseResult;

  /** Resolve an import specifier to an absolute path */
  resolveImport(
    importSource: string,
    fromFile: string,
    config: ResolverConfig
  ): string | undefined;

  /** Find usages of a symbol within a file */
  findUsages(
    filePath: string,
    content: string,
    symbolName: string
  ): UsageInfo[];
}
```

## Language Parsers

### TypeScript/JavaScript Parser
```typescript
// src/parsers/typescript.ts
import * as ts from 'typescript';

export class TypeScriptParser implements LanguageParser {
  extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

  parseFile(filePath: string, content: string): FileParseResult {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest);
    // ... existing parsing logic extracted here
  }

  resolveImport(importSource: string, fromFile: string, config: ResolverConfig): string | undefined {
    // ... existing resolution logic (path aliases, node resolution)
  }
}
```

### Python Parser (example)
```typescript
// src/parsers/python.ts
import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';

export class PythonParser implements LanguageParser {
  extensions = ['.py'];
  private parser: Parser;

  constructor() {
    this.parser = new Parser();
    this.parser.setLanguage(Python);
  }

  parseFile(filePath: string, content: string): FileParseResult {
    const tree = this.parser.parse(content);
    const exports: Export[] = [];
    const imports: Import[] = [];

    // Walk AST to find:
    // - 'def' at module level -> function export
    // - 'class' at module level -> class export
    // - 'import X' / 'from X import Y' -> imports
    // - '__all__' -> explicit exports

    return { filePath, exports, imports, symbols: new Map() };
  }

  resolveImport(importSource: string, fromFile: string): string | undefined {
    // Python import resolution:
    // - Relative imports (from . import X)
    // - Absolute imports (import package.module)
    // - Check __init__.py for packages
  }
}
```

### Go Parser (example)
```typescript
// src/parsers/go.ts
export class GoParser implements LanguageParser {
  extensions = ['.go'];

  parseFile(filePath: string, content: string): FileParseResult {
    // Use tree-sitter-go or call 'go/parser' via child process
    // Exports: capitalized identifiers (Go's visibility rule)
    // Imports: import statements
  }
}
```

## Parser Registry

```typescript
// src/core/language/registry.ts

class ParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();

  register(parser: LanguageParser): void {
    for (const ext of parser.extensions) {
      this.parsers.set(ext, parser);
    }
  }

  getParser(filePath: string): LanguageParser | undefined {
    const ext = path.extname(filePath);
    return this.parsers.get(ext);
  }
}

// Default registry with TypeScript
export const defaultRegistry = new ParserRegistry();
defaultRegistry.register(new TypeScriptParser());
```

## Updated Analyzer

```typescript
// src/core/analyzer.ts

class ProjectAnalyzer {
  constructor(
    private rootDir: string,
    private registry: ParserRegistry,
    private config: AnalyzerConfig
  ) {}

  async analyze(): Promise<ProjectAnalysis> {
    const files = await this.findSourceFiles();

    for (const filePath of files) {
      const parser = this.registry.getParser(filePath);
      if (!parser) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const result = parser.parseFile(filePath, content);

      // Process language-agnostic FileParseResult
      // Build dependency graph, symbol traces, etc.
    }
  }
}
```

## Implementation Plan

### Phase 1: Extract TypeScript Parser
1. Create `LanguageParser` interface
2. Extract existing TS parsing logic into `TypeScriptParser`
3. Update `ProjectAnalyzer` to use the parser interface
4. Ensure all tests pass

### Phase 2: Add Tree-sitter Infrastructure
1. Add tree-sitter as dependency
2. Create base class for tree-sitter parsers
3. Implement Python parser as proof of concept

### Phase 3: Language-Specific Features
1. Handle language-specific concepts (Python's `__all__`, Go's capitalization)
2. Add language-specific resolution (Python packages, Go modules)
3. Update tidy command to use language-specific prompts

## Dependencies

For multi-language support via tree-sitter:
```json
{
  "dependencies": {
    "tree-sitter": "^0.20.0",
    "tree-sitter-python": "^0.20.0",
    "tree-sitter-go": "^0.20.0",
    "tree-sitter-rust": "^0.20.0"
  }
}
```

## Language Support Matrix

| Feature | TypeScript | Python | Go | Rust |
|---------|------------|--------|-----|------|
| Export detection | ✅ | 🔲 | 🔲 | 🔲 |
| Import resolution | ✅ | 🔲 | 🔲 | 🔲 |
| Usage tracking | ✅ | 🔲 | 🔲 | 🔲 |
| Circular deps | ✅ | 🔲 | 🔲 | 🔲 |
| AI tidy | ✅ | 🔲 | 🔲 | 🔲 |

✅ = Implemented, 🔲 = Planned
