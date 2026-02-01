import { bFunction } from './b.js';

export function aFunction(): string {
  return 'a' + bFunction();
}
