import * as path from 'node:path';
import type { LanguageParser } from './types.js';

/**
 * Registry for language parsers
 * Manages which parser handles which file extensions
 */
export class ParserRegistry {
  private parsers: Map<string, LanguageParser> = new Map();
  private parsersByExtension: Map<string, LanguageParser> = new Map();

  /**
   * Register a language parser
   */
  register(parser: LanguageParser): void {
    this.parsers.set(parser.id, parser);
    for (const ext of parser.extensions) {
      this.parsersByExtension.set(ext.toLowerCase(), parser);
    }
  }

  /**
   * Get a parser by its ID
   */
  getById(id: string): LanguageParser | undefined {
    return this.parsers.get(id);
  }

  /**
   * Get the appropriate parser for a file based on its extension
   */
  getForFile(filePath: string): LanguageParser | undefined {
    const ext = path.extname(filePath).toLowerCase();
    return this.parsersByExtension.get(ext);
  }

  /**
   * Check if a file is supported by any registered parser
   */
  isSupported(filePath: string): boolean {
    return this.getForFile(filePath) !== undefined;
  }

  /**
   * Get all supported file extensions
   */
  getSupportedExtensions(): string[] {
    return Array.from(this.parsersByExtension.keys());
  }

  /**
   * Get all registered parsers
   */
  getAllParsers(): LanguageParser[] {
    return Array.from(this.parsers.values());
  }
}

// Global default registry
export const defaultRegistry = new ParserRegistry();
