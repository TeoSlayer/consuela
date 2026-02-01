# Consuela: AI Codebase Janitor

## The Problem

You built something with AI. It works. But it's a **mess**:

```
src/
├── utils.ts          # 800 lines, 40 functions, half are duplicates
├── helpers.ts        # Same functions as utils.ts but slightly different
├── api.ts            # Fetches data, also validates, also transforms, also logs
├── components/
│   ├── Button.tsx    # 3 different Button components
│   ├── Button2.tsx   # "I'll clean this up later"
│   └── ButtonNew.tsx # "This one is the good one"
└── types.ts          # 200 interfaces, 50 are unused
```

You want to clean it up, but you're afraid to touch it because **it works** and you don't know what depends on what.

## The Solution

Consuela dives into the mess, understands it structurally, and uses AI to clean it up **without breaking anything**.

```bash
# Step 1: Understand the mess
consuela scan

# Step 2: See what's wrong
consuela diagnose

# Step 3: Clean it up (AI + structural verification)
consuela tidy src/utils.ts

# Step 4: Verify nothing broke
consuela verify
```

## Core Workflow

### 1. SCAN - Build the "skeleton"
```
📊 Scanned 47 files

Functions:     234
  Pure:        89 (38%) ← Safe to refactor
  Impure:      145 (62%) ← Need care

Problems detected:
  ⚠ 12 duplicate function signatures
  ⚠ 34 unused exports
  ⚠ 8 files with >500 lines
  ⚠ 3 circular dependency chains
```

### 2. DIAGNOSE - Identify the mess
```
🔍 Codebase Health: 34/100 (Poor)

Critical Issues:
  src/utils.ts
    - 847 lines (should be <200)
    - 12 functions could be extracted to separate modules
    - 5 functions are duplicates of helpers.ts

  src/api.ts
    - Mixed concerns: fetching + validation + transformation
    - Suggest splitting into: api.ts, validators.ts, transformers.ts

  Duplicate Code:
    formatDate() exists in 3 files with minor variations
    → Suggest consolidating to src/utils/date.ts
```

### 3. TIDY - AI cleanup with guardrails
```bash
consuela tidy src/utils.ts
```
```
🧹 Tidying src/utils.ts

AI Analysis:
  - Found 5 functions that belong in separate modules
  - Found 3 unused functions (safe to remove)
  - Found 2 functions with duplicate logic

Proposed Changes:
  1. Extract date functions → src/utils/date.ts
  2. Extract string functions → src/utils/string.ts
  3. Remove unused: oldHelper(), deprecatedFunc(), tempFix()
  4. Merge duplicate: formatName() and formatUserName()

Structural Verification:
  ✓ No exported functions removed
  ✓ All call sites preserved
  ✓ No circular dependencies introduced

Apply changes? [y/n]
```

### 4. VERIFY - Prove nothing broke
```
✓ Structural integrity verified
  - All 234 functions still reachable
  - All 89 exports still available
  - No broken imports
```

## What Makes This Different

| Other Tools | Consuela |
|-------------|----------|
| Suggest changes | Suggest AND verify safety |
| Work on single files | Understand whole codebase |
| Text-based refactoring | Graph-based refactoring |
| Hope it doesn't break | Prove it doesn't break |

## The Guarantee

> "If Consuela says the refactor is safe, it's safe."

The AI can change:
- ✅ Function implementations
- ✅ Variable names (internal)
- ✅ Code organization within a file
- ✅ Comments and formatting

The AI cannot change:
- ❌ Exported function signatures
- ❌ The call graph (who calls what)
- ❌ Public interfaces
- ❌ Module boundaries (without approval)

## Target User

**"I built this with AI and now I need to maintain it."**

- Prototypers who shipped v1 with AI
- Teams inheriting AI-generated codebases
- Solo devs who "moved fast and broke things"
- Anyone with a working mess they're afraid to touch
