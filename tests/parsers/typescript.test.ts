import { describe, it, expect } from 'vitest';
import { TypeScriptParser } from '../../src/parsers/typescript.js';

describe('TypeScriptParser', () => {
  const parser = new TypeScriptParser();

  describe('parseFile', () => {
    it('extracts function exports', () => {
      const content = `export function myFunc(): string { return 'hello'; }`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('myFunc');
      expect(result.exports[0].kind).toBe('function');
    });

    it('extracts class exports', () => {
      const content = `export class MyClass { getValue(): number { return 42; } }`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyClass');
      expect(result.exports[0].kind).toBe('class');
    });

    it('extracts const exports', () => {
      const content = `export const MY_CONST = 42;`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MY_CONST');
      expect(result.exports[0].kind).toBe('constant');
    });

    it('extracts interface exports', () => {
      const content = `export interface MyInterface { name: string; }`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyInterface');
      expect(result.exports[0].kind).toBe('interface');
    });

    it('extracts type exports', () => {
      const content = `export type MyType = string | number;`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyType');
      expect(result.exports[0].kind).toBe('type');
    });

    it('extracts enum exports', () => {
      const content = `export enum Status { Active, Inactive }`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('Status');
      expect(result.exports[0].kind).toBe('enum');
    });

    it('extracts default exports', () => {
      const content = `export default function main() {}`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('default');
      expect(result.exports[0].isDefault).toBe(true);
    });

    it('extracts named imports', () => {
      const content = `import { foo, bar as baz } from './utils.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0].name).toBe('foo');
      expect(result.imports[1].name).toBe('bar');
      expect(result.imports[1].alias).toBe('baz');
    });

    it('extracts default imports', () => {
      const content = `import myDefault from './utils.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('default');
      expect(result.imports[0].alias).toBe('myDefault');
      expect(result.imports[0].isDefault).toBe(true);
    });

    it('extracts namespace imports', () => {
      const content = `import * as utils from './utils.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('*');
      expect(result.imports[0].alias).toBe('utils');
    });

    it('handles re-exports', () => {
      const content = `export { foo, bar } from './other.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0].isReExport).toBe(true);
      expect(result.exports[1].isReExport).toBe(true);
    });

    it('handles star re-exports', () => {
      const content = `export * from './other.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('*');
      expect(result.exports[0].isReExport).toBe(true);
    });

    it('populates local symbols map', () => {
      const content = `import { foo as bar } from './utils.js';`;
      const result = parser.parseFile('test.ts', content);

      expect(result.localSymbols.get('bar')).toEqual({
        source: './utils.js',
        originalName: 'foo',
      });
    });
  });

  describe('findUsages', () => {
    it('finds function calls', () => {
      const content = `
import { myFunc } from './utils.js';
const result = myFunc();
`;
      const usages = parser.findUsages('test.ts', content, 'myFunc', new Map());

      expect(usages.length).toBeGreaterThan(0);
      expect(usages.some(u => u.type === 'call')).toBe(true);
    });

    it('excludes import declarations', () => {
      const content = `import { myFunc } from './utils.js';`;
      const usages = parser.findUsages('test.ts', content, 'myFunc', new Map());

      expect(usages).toHaveLength(0);
    });
  });

  describe('metadata', () => {
    it('has correct id', () => {
      expect(parser.id).toBe('typescript');
    });

    it('has correct extensions', () => {
      expect(parser.extensions).toContain('.ts');
      expect(parser.extensions).toContain('.tsx');
      expect(parser.extensions).toContain('.js');
      expect(parser.extensions).toContain('.jsx');
    });

    it('provides tidy prompt', () => {
      const prompt = parser.getTidyPrompt();
      expect(prompt).toContain('TypeScript');
    });
  });
});
