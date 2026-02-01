export * from './types.js';
export * from './registry.js';
export * from './typescript.js';
export * from './python.js';

// Set up default registry with all parsers
import { defaultRegistry } from './registry.js';
import { TypeScriptParser } from './typescript.js';
import { PythonParser } from './python.js';

defaultRegistry.register(new TypeScriptParser());
defaultRegistry.register(new PythonParser());
