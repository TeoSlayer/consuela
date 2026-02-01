// Used export
export function usedFunction(): string {
  return 'used';
}

// Unused export
export function unusedFunction(): string {
  return 'unused';
}

// Used class
export class UsedClass {
  getValue(): number {
    return 42;
  }
}

// Unused class
export class UnusedClass {
  getValue(): number {
    return 0;
  }
}

// Used type
export type UsedType = {
  name: string;
  value: number;
};

// Unused type
export type UnusedType = {
  id: string;
};

// Used const
export const USED_CONST = 'used';

// Unused const
export const UNUSED_CONST = 'unused';
