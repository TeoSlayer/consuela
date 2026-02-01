import { BaseClass, BaseInterface, config, createValue, processValue } from './base.js';

// Class extension
export class ExtendedClass extends BaseClass {
  extraValue: string = 'extra';
}

// Interface implementation
export class ImplementingClass implements BaseInterface {
  name = 'impl';
  getName(): string {
    return this.name;
  }
}

// Spread usage
export const extendedConfig = {
  ...config,
  timeout: 5000,
};

// Return usage
export function getValueFromBase(): number {
  return createValue();
}

// Pass as argument
export function doubleValue(): number {
  const val = createValue();
  return processValue(val);
}

// Assignment usage
export let assignedValue = createValue();
