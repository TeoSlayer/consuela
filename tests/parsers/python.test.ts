import { describe, it, expect } from 'vitest';
import { PythonParser } from '../../src/parsers/python.js';

describe('PythonParser', () => {
  const parser = new PythonParser();

  describe('parseFile', () => {
    it('extracts function definitions', () => {
      const content = `def my_function():
    return "hello"`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('my_function');
      expect(result.exports[0].kind).toBe('function');
    });

    it('extracts async function definitions', () => {
      const content = `async def async_func():
    await something()`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('async_func');
      expect(result.exports[0].kind).toBe('function');
    });

    it('extracts class definitions', () => {
      const content = `class MyClass:
    def method(self):
        pass`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MyClass');
      expect(result.exports[0].kind).toBe('class');
    });

    it('extracts constants (UPPER_CASE)', () => {
      const content = `MY_CONSTANT = 42`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('MY_CONSTANT');
      expect(result.exports[0].kind).toBe('constant');
    });

    it('extracts variables', () => {
      const content = `my_variable = "hello"`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('my_variable');
      expect(result.exports[0].kind).toBe('variable');
    });

    it('excludes private names (starting with _)', () => {
      const content = `def _private_func():
    pass

def public_func():
    pass`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('public_func');
    });

    it('respects __all__ when defined', () => {
      const content = `__all__ = ['exported_func']

def exported_func():
    pass

def not_exported():
    pass`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0].name).toBe('exported_func');
    });

    it('parses from X import Y', () => {
      const content = `from os import path`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('path');
      expect(result.imports[0].source).toBe('os');
    });

    it('parses from X import Y as Z', () => {
      const content = `from os import path as ospath`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('path');
      expect(result.imports[0].alias).toBe('ospath');
    });

    it('parses from X import *', () => {
      const content = `from utils import *`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('*');
    });

    it('parses import X', () => {
      const content = `import os`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('os');
      expect(result.imports[0].source).toBe('os');
    });

    it('parses import X as Y', () => {
      const content = `import numpy as np`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0].name).toBe('numpy');
      expect(result.imports[0].alias).toBe('np');
    });

    it('parses multiple imports', () => {
      const content = `from typing import List, Dict, Optional`;
      const result = parser.parseFile('test.py', content);

      expect(result.imports).toHaveLength(3);
      expect(result.imports.map(i => i.name)).toEqual(['List', 'Dict', 'Optional']);
    });

    it('populates local symbols map', () => {
      const content = `from os import path as ospath`;
      const result = parser.parseFile('test.py', content);

      expect(result.localSymbols.get('ospath')).toEqual({
        source: 'os',
        originalName: 'path',
      });
    });

    it('extracts function signatures', () => {
      const content = `def greet(name: str, age: int = 0) -> str:
    return f"Hello {name}"`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports[0].signature).toContain('name');
      expect(result.exports[0].signature).toContain('str');
    });

    it('extracts class method signatures', () => {
      const content = `class MyClass:
    def public_method(self):
        pass

    def _private_method(self):
        pass`;
      const result = parser.parseFile('test.py', content);

      expect(result.exports[0].signature).toContain('public_method');
      expect(result.exports[0].signature).not.toContain('_private_method');
    });
  });

  describe('findUsages', () => {
    it('finds function calls', () => {
      const content = `from utils import my_func
result = my_func()`;
      const usages = parser.findUsages('test.py', content, 'my_func', new Map());

      expect(usages.length).toBeGreaterThan(0);
      expect(usages.some(u => u.type === 'call')).toBe(true);
    });

    it('excludes import lines', () => {
      const content = `from utils import my_func`;
      const usages = parser.findUsages('test.py', content, 'my_func', new Map());

      expect(usages).toHaveLength(0);
    });

    it('excludes definition lines', () => {
      const content = `def my_func():
    pass`;
      const usages = parser.findUsages('test.py', content, 'my_func', new Map());

      expect(usages).toHaveLength(0);
    });

    it('finds class inheritance', () => {
      const content = `from base import BaseClass
class MyClass(BaseClass):
    pass`;
      const usages = parser.findUsages('test.py', content, 'BaseClass', new Map());

      expect(usages.some(u => u.type === 'extend')).toBe(true);
    });
  });

  describe('metadata', () => {
    it('has correct id', () => {
      expect(parser.id).toBe('python');
    });

    it('has correct extensions', () => {
      expect(parser.extensions).toContain('.py');
    });

    it('provides tidy prompt', () => {
      const prompt = parser.getTidyPrompt();
      expect(prompt).toContain('Python');
      expect(prompt).toContain('PEP 8');
    });
  });
});
