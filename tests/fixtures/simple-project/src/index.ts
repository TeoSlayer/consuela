import { usedFunction, UsedClass, USED_CONST } from './utils.js';
import type { UsedType } from './utils.js';

// Use the imports
const result = usedFunction();
console.log(result);

const instance = new UsedClass();
console.log(instance.getValue());

console.log(USED_CONST);

const data: UsedType = { name: 'test', value: 1 };
console.log(data);

export function main(): void {
  console.log('main');
}
