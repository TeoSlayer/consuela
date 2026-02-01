// Base class for extension
export class BaseClass {
  value: number = 0;
  getValue(): number {
    return this.value;
  }
}

// Interface for implementation
export interface BaseInterface {
  name: string;
  getName(): string;
}

// Object for spreading
export const config = {
  host: 'localhost',
  port: 3000,
};

// Function to return
export function createValue(): number {
  return 42;
}

// Function to pass as argument
export function processValue(x: number): number {
  return x * 2;
}
