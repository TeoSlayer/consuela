import { internalFunc, INTERNAL_CONST } from './index.js';

export function consume(): string {
  console.log(INTERNAL_CONST);
  return internalFunc();
}
