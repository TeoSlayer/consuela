# Consuela

<p align="center">
  <img src="assets/consuela.png" alt="Consuela" width="200">
</p>

<p align="center">
  <strong>"No no no... I clean."</strong><br>
  <em>Automatic code cleanup for TypeScript/JavaScript projects</em>
</p>

<p align="center">
  <em>You don't tell Consuela what to do. She just cleans.</em>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/consuela-cli"><img src="https://img.shields.io/npm/v/consuela-cli.svg?style=flat-square" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/consuela-cli"><img src="https://img.shields.io/npm/dm/consuela-cli.svg?style=flat-square" alt="npm downloads"></a>
  <a href="https://github.com/TeoSlayer/consuela/actions"><img src="https://img.shields.io/github/actions/workflow/status/TeoSlayer/consuela/ci.yml?style=flat-square&label=tests" alt="tests"></a>
  <a href="https://codecov.io/gh/TeoSlayer/consuela"><img src="https://img.shields.io/codecov/c/github/TeoSlayer/consuela?style=flat-square" alt="coverage"></a>
  <a href="https://github.com/TeoSlayer/consuela/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/consuela-cli.svg?style=flat-square" alt="license"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.0+-blue?style=flat-square&logo=typescript" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-18+-green?style=flat-square&logo=node.js" alt="Node.js">
</p>

---

## What It Does

Consuela finds problems in your codebase and **fixes them automatically**:

- **Dead code** - Unused exports, empty files
- **Large files** - AI splits them into focused modules
- **Messy structure** - AI reorganizes your folders

No more manual cleanup. Just run `consuela fix`.

## How It Works

Consuela builds a **complete dependency graph** of your codebase:

- Every export (functions, classes, types, variables)
- Every import and where it's used
- Call sites, references, and relationships between symbols
- Circular dependencies and architectural bottlenecks

This graph drives all analysis and changes. When Consuela removes dead code or reorganizes files, it knows exactly what depends on what - so nothing breaks.

### The `.consuela` Folder

On first run, Consuela creates a `.consuela/` folder in your project root:

```
.consuela/
├── analysis-cache.json    # Cached dependency graph
└── gold-standard.json     # Structural snapshot (optional)
```

- **analysis-cache.json** - Stores the dependency graph so subsequent runs are fast. Automatically invalidated when files change (based on content hashes).
- **gold-standard.json** - A snapshot of your codebase structure. Used to verify AI changes don't break things.

**Add `.consuela/` to your `.gitignore`** - it's machine-specific cache data.

## Install

```bash
npm install -g consuela-cli
```

This installs the `consuela` command globally.

## Get Started

```bash
# 1. See your codebase summary
consuela

# 2. Fix dead code automatically
consuela fix

# 3. Full cleanup with AI (optional)
consuela fix --all
```

That's it. Consuela shows you what's wrong and fixes it.

## Commands

### `consuela`

Run with no arguments to see a quick health summary of your codebase.

```
$ consuela

🧹 Consuela - Code Analysis Tool

✔ Analysis completed in 1.2s

📊 Project Summary
────────────────────────────────────────
  Files analyzed:    50
  Total exports:     301
    Functions:       152
    Classes:         14
    Types:           123

  ⚠ Found 2 potentially unused exports
    Run `consuela fix` to remove them automatically
```

### `consuela fix`

The main command. Fixes issues and verifies the build still works.

```bash
consuela fix              # Remove dead code
consuela fix --deep       # + AI cleans large files
consuela fix --all        # + AI restructures codebase
consuela fix --dry-run    # Preview without changing anything
```

**Example output:**

```
$ consuela fix

🔧 Consuela Fix

✔ Analysis complete

  Health Score: 45/100
    Dead code: 5 | Large files: 3 | Circular: 1

✔ Removed 5 unused export(s)
✔ Build verified

  Health: 45/100 → 55/100
          +10 points 🎉

  ✓ Build passes - changes are safe

  Next steps:
    • Run `consuela fix --deep` for AI-powered cleanup
    • Run `git diff` to review changes
```

### `consuela diagnose`

Get a detailed health report with specific issues.

```bash
consuela diagnose
```

Shows:
- Health score (0-100)
- Large files that need splitting
- Dead code to remove
- Circular dependencies
- Duplicate functions
- Specific recommendations

### `consuela trace <symbol>`

Find everywhere a function, class, or type is used.

```bash
consuela trace useState
consuela trace MyComponent
consuela trace "src/utils.ts:formatDate"
```

Shows:
- Where it's defined
- Every file that imports it
- Every usage with line numbers
- Impact if you change it

### `consuela impact <file>`

See what breaks if you change a file.

```bash
consuela impact src/api.ts
consuela impact src/components/Button.tsx
```

Shows:
- Direct dependents
- Transitive impact (files affected indirectly)
- Risk assessment
- Recommendations

### `consuela reorganize`

AI suggests a better folder structure and moves files for you.

```bash
consuela reorganize              # Analyze and propose
consuela reorganize --dry-run    # Preview only
consuela reorganize --undo       # Restore from backup
```

Shows a before/after tree comparison and explains why each move makes sense.

### `consuela config`

Set up or manage your API key for AI features.

```bash
consuela config
```

Prompts you to enter your Gemini API key. The key is stored globally on your machine (not in your project), so it works across all projects.

## AI Features (Free)

Some features use Google's Gemini AI. It's **free** - just get an API key.

### Setup (one time)

```bash
consuela config
```

This will prompt you for your API key and store it securely on your machine (not in your project).

**To get a free API key:**

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Copy the key
4. Run `consuela config` and paste it

The key is stored globally in your user config, so it works across all your projects.

### What AI enables

| Command | What it does |
|---------|--------------|
| `consuela fix --deep` | AI analyzes large files and cleans them up |
| `consuela fix --all` | AI restructures your entire codebase |
| `consuela reorganize` | AI suggests better folder structure |

### Managing your key

```bash
consuela config    # Update or remove your API key
```

You can update or remove your API key anytime by running `consuela config` again.

## Configuration

Create `.consuelarc` in your project root:

```json
{
  "ignore": ["**/*.test.ts", "**/__mocks__/**"],
  "entryPoints": ["src/main.ts", "src/index.ts"]
}
```

Or add to `package.json`:

```json
{
  "consuela": {
    "ignore": ["tests/**"],
    "entryPoints": ["src/index.ts"]
  }
}
```

### Options

| Option | Description |
|--------|-------------|
| `ignore` | Glob patterns to skip |
| `entryPoints` | Files that are allowed to have unused exports |

## CI/CD

Use `--fail` to exit with code 1 when issues are found:

```bash
consuela fix --dry-run --fail    # Fail if there's dead code
```

Example GitHub Action:

```yaml
- name: Check for dead code
  run: npx consuela fix --dry-run --fail
```

## Advanced Commands

Power users can access additional commands:

```bash
consuela advanced --help
```

Includes: `unused`, `circular`, `exports`, `diff`, `tidy`, `map`, `scan`, `verify`, `extract`, `cleanup`, `split`, `merge`, `ai-fix`

## Supported Languages

| Language | Extensions | Status |
|----------|------------|--------|
| TypeScript | `.ts`, `.tsx` | ✅ Full support |
| JavaScript | `.js`, `.jsx`, `.mjs` | ✅ Full support |
| Python | `.py` | 🚧 Experimental |

*Rome wasn't built in a day. More languages coming soon.*

## AI Model

Consuela uses **Google Gemini** (gemini-3-flash-preview) for AI features:
- Code analysis and cleanup suggestions
- File splitting recommendations
- Codebase reorganization

The Gemini API has a generous free tier - no credit card required.

## Ignored by Default

- `node_modules/`
- `dist/`, `build/`
- `.git/`
- `.consuela/`

## Cache

Analysis is cached in `.consuela/` for faster runs. Add it to `.gitignore`.

## License

**AGPL-3.0** - See [LICENSE](LICENSE) for details.

This means:
- You can use Consuela freely for any purpose
- If you modify and distribute it, you must open-source your changes under AGPL
- If you use it in a SaaS product, you must open-source your entire application

**Commercial License:** If you need to use Consuela in proprietary software without the AGPL requirements, contact us for a commercial license.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and CLA.
