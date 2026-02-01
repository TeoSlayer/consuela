/**
 * Split operation - Extract functions from a file into a new file
 * Handles dependency tracking, import updates, and preserves structure
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import {
  createGraphAnalyzer,
  type FunctionGraph,
} from '../../graph/index.js';
import { createGeminiClient } from '../../core/gemini.js';
import { getGlobalApiKey } from '../../commands/config.js';
import type { SplitPreview } from '../types.js';
import { splitFile, parseSourceFile,                      previewSplit } from './split-getscriptkind.js';
export { splitFile, previewSplit, parseSourceFile } from './split-getscriptkind.js';

export interface SplitOptions {
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

export interface SplitResult {
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
