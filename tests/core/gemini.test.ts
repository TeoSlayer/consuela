import { describe, it, expect, vi, beforeEach } from 'vitest';

// Create mock function that will be populated in tests
const mockGenerateContent = vi.fn();

// Mock the Google Generative AI module - must be hoisted
vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: mockGenerateContent,
        };
      }
    },
  };
});

// Import after mock is set up
import { createGeminiClient } from '../../src/core/gemini.js';

describe('GeminiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createGeminiClient', () => {
    it('creates a client instance', () => {
      mockGenerateContent.mockResolvedValue({
        response: { text: () => '' },
      });
      const client = createGeminiClient('test-api-key');
      expect(client).toBeDefined();
      expect(typeof client.tidyCode).toBe('function');
    });
  });

  describe('tidyCode', () => {
    it('parses response with all sections', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => `
### REFACTORED_CODE_START
const x = 1;
### REFACTORED_CODE_END

### CHANGES
- Simplified variable declaration
- Removed unused import

### REASONING
The code was simplified for readability.
`,
        },
      });

      const client = createGeminiClient('test-api-key');
      const result = await client.tidyCode('test.ts', 'const x = 1;', {});

      expect(result.cleanedCode).toBe('const x = 1;');
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0]).toBe('Simplified variable declaration');
      expect(result.reasoning).toContain('simplified for readability');
    });

    it('handles empty response sections', async () => {
      mockGenerateContent.mockResolvedValue({
        response: {
          text: () => `No changes needed.`,
        },
      });

      const client = createGeminiClient('test-api-key');
      const result = await client.tidyCode('test.ts', 'const x = 1;', {});

      expect(result.cleanedCode).toBe('');
      expect(result.changes).toHaveLength(0);
      expect(result.reasoning).toBe('');
    });

    it('includes context in prompt when provided', async () => {
      let capturedPrompt = '';
      mockGenerateContent.mockImplementation((prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          response: {
            text: () => `### REFACTORED_CODE_START
code
### REFACTORED_CODE_END

### CHANGES
- None

### REASONING
None`,
          },
        });
      });

      const client = createGeminiClient('test-api-key');
      await client.tidyCode('test.ts', 'const x = 1;', {
        exports: [{ name: 'foo', kind: 'function', usageCount: 5 }],
        unusedExports: ['bar'],
        dependents: ['other.ts'],
      });

      expect(capturedPrompt).toContain('foo');
      expect(capturedPrompt).toContain('5');
      expect(capturedPrompt).toContain('bar');
      expect(capturedPrompt).toContain('other.ts');
    });

    it('handles dependents list with more than 10 items', async () => {
      let capturedPrompt = '';
      mockGenerateContent.mockImplementation((prompt) => {
        capturedPrompt = prompt;
        return Promise.resolve({
          response: {
            text: () => `### REFACTORED_CODE_START
code
### REFACTORED_CODE_END

### CHANGES
- None

### REASONING
None`,
          },
        });
      });

      const dependents = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      const client = createGeminiClient('test-api-key');
      await client.tidyCode('test.ts', 'const x = 1;', { dependents });

      expect(capturedPrompt).toContain('file0.ts');
      expect(capturedPrompt).toContain('file9.ts');
      expect(capturedPrompt).toContain('... and 5 more');
      expect(capturedPrompt).toContain('15 files depend on this');
    });
  });
});
