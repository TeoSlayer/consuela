import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock storage
let mockStorage: Record<string, any> = {};

// Mock Conf before any imports
vi.mock('conf', () => {
  return {
    default: class MockConf {
      get(key: string) {
        return mockStorage[key];
      }
      set(key: string, value: any) {
        mockStorage[key] = value;
      }
      delete(key: string) {
        delete mockStorage[key];
      }
    },
  };
});

// Mock inquirer
const mockPrompt = vi.fn();
vi.mock('inquirer', () => ({
  default: {
    prompt: mockPrompt,
  },
}));

const originalConsoleLog = console.log;

describe('configCommand', () => {
  let consoleLogs: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage = {};
    consoleLogs = [];
    console.log = vi.fn((...args) => consoleLogs.push(args.join(' ')));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  it('prompts for API key when none exists', async () => {
    mockPrompt.mockResolvedValueOnce({ geminiApiKey: 'test-api-key-12345' });

    const { configCommand } = await import('../../src/commands/config.js');
    await configCommand();

    expect(mockPrompt).toHaveBeenCalled();
    expect(mockStorage.geminiApiKey).toBe('test-api-key-12345');
    const output = consoleLogs.join('\n');
    expect(output).toContain('API key saved successfully');
  });

  it('shows options when API key exists', async () => {
    mockStorage.geminiApiKey = 'existing-key-12345';
    mockPrompt.mockResolvedValueOnce({ action: 'cancel' });

    const { configCommand } = await import('../../src/commands/config.js');
    await configCommand();

    expect(mockPrompt).toHaveBeenCalled();
    const output = consoleLogs.join('\n');
    expect(output).toContain('Current API key');
  });

  it('allows updating API key', async () => {
    mockStorage.geminiApiKey = 'existing-key-12345';
    mockPrompt
      .mockResolvedValueOnce({ action: 'update' })
      .mockResolvedValueOnce({ geminiApiKey: 'new-api-key-67890' });

    const { configCommand } = await import('../../src/commands/config.js');
    await configCommand();

    expect(mockStorage.geminiApiKey).toBe('new-api-key-67890');
  });

  it('allows removing API key', async () => {
    mockStorage.geminiApiKey = 'existing-key-12345';
    mockPrompt.mockResolvedValueOnce({ action: 'remove' });

    const { configCommand } = await import('../../src/commands/config.js');
    await configCommand();

    expect(mockStorage.geminiApiKey).toBeUndefined();
    const output = consoleLogs.join('\n');
    expect(output).toContain('API key removed');
  });
});

describe('getGlobalApiKey', () => {
  beforeEach(() => {
    mockStorage = {};
  });

  it('returns API key when set', async () => {
    mockStorage.geminiApiKey = 'test-key';

    const { getGlobalApiKey } = await import('../../src/commands/config.js');
    expect(getGlobalApiKey()).toBe('test-key');
  });

  it('returns undefined when not set', async () => {
    const { getGlobalApiKey } = await import('../../src/commands/config.js');
    expect(getGlobalApiKey()).toBeUndefined();
  });
});

describe('hasGlobalApiKey', () => {
  beforeEach(() => {
    mockStorage = {};
  });

  it('returns true when API key exists', async () => {
    mockStorage.geminiApiKey = 'test-key';

    const { hasGlobalApiKey } = await import('../../src/commands/config.js');
    expect(hasGlobalApiKey()).toBe(true);
  });

  it('returns false when API key does not exist', async () => {
    const { hasGlobalApiKey } = await import('../../src/commands/config.js');
    expect(hasGlobalApiKey()).toBe(false);
  });
});

describe('configCommand validation', () => {
  let localConsoleLogs: string[];

  beforeEach(() => {
    mockStorage = {};
    localConsoleLogs = [];
    console.log = vi.fn((...args) => localConsoleLogs.push(args.join(' ')));
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  it('validates API key length', async () => {
    // Mock prompt to capture the validate function and test it
    let validateFn: ((input: string) => boolean | string) | undefined;
    mockPrompt.mockImplementation((questions: any[]) => {
      const question = questions[0];
      if (question.validate) {
        validateFn = question.validate;
      }
      return Promise.resolve({ geminiApiKey: 'valid-api-key-12345' });
    });

    const { configCommand } = await import('../../src/commands/config.js');
    await configCommand();

    // Test the validate function
    if (validateFn) {
      expect(validateFn('')).toBe('Please enter a valid Gemini API key');
      expect(validateFn('short')).toBe('Please enter a valid Gemini API key');
      expect(validateFn('valid-api-key-12345')).toBe(true);
    }
  });
});
