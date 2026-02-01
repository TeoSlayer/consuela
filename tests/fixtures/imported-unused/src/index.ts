// Import both, but only use one
import { importedButNotUsed, actuallyUsed } from './utils.js';

// Use actuallyUsed
export const result = actuallyUsed();

// importedButNotUsed is imported but never called
