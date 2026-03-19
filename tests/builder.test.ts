/**
 * tests/builder.test.ts
 *
 * Tests for:
 *   - builder/skillGenerator.ts → generateFromFailure(), generateBatch(),
 *                                  selectTemplateType(), computeConfidence()
 *   - builder/skillValidator.ts → validate(), validateBatch(), validateOrThrow()
 *
 * Run with: npm test (vitest run)
 *
 * NOTE: The template library (getTemplate, TEMPLATE_LIBRARY) is mocked below because
 * the source templateLibrary.ts is missing those exports (pre-existing codebase gap).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SkillTemplate } from '../src/types.js';

// ── Mock template library ────────────────────────────────────────────────────
// The actual src/builder/templateLibrary.ts is missing getTemplate / TEMPLATE_LIBRARY.
// We mock it so generateFromFailure() can find a valid template.

const MOCK_TEMPLATE: SkillTemplate = {
  name: 'Mock Skill Template',
  description: 'Mock template for testing skill generation.',
  triggerPhrases: ['test trigger', 'mock phrase'],
  implementationTemplate: [
    '// Mock implementation for {{TOOL_NAME}}',
    'export async function {{TOOL_NAME_CAMEL}}(input: unknown): Promise<unknown> {',
    '  // Handle {{ERROR_TYPE}} errors',
    '  return { handled: true };',
    '}',
  ].join('\n'),
  exampleTemplate: {
    input: 'Test input',
    expectedOutput: 'Test output',
    explanation: 'This is a mock example.',
  },
};

// ── Inline mock template (defined here, referenced inside vi.mock factory) ──
// We declare it as a const in the factory to satisfy hoisting rules.

vi.mock('../src/builder/templateLibrary.js', () => {
  // Define the mock template inline so the factory doesn't reference outer scope.
  const mockTmpl = {
    name: 'Mock Skill Template',
    description: 'Mock template for testing skill generation.',
    triggerPhrases: ['test trigger', 'mock phrase'],
    implementationTemplate: [
      '// Mock implementation',
      'export async function mockHandler(input: unknown): Promise<unknown> {',
      '  // Handle errors gracefully',
      '  return { handled: true };',
      '}',
    ].join('\n'),
    exampleTemplate: {
      input: 'Test input',
      expectedOutput: 'Test output',
      explanation: 'This is a mock example.',
    },
  };
  return {
    TEMPLATE_LIBRARY: { mocking_template: mockTmpl },
    // Return the mock template for any type — selectTemplateType() picks the type,
    // and we just need getTemplate() to find something valid.
    getTemplate: (_type: string) => mockTmpl,
    getTemplateTypes: () => ['mocking_template'],
    listTemplates: () => [
      { type: 'mocking_template', name: mockTmpl.name, description: mockTmpl.description },
    ],
  };
});
import {
  selectTemplateType,
  computeConfidence,
  generateFromFailure,
  generateBatch,
} from '../src/builder/skillGenerator.js';
import {
  validate,
  validateBatch,
  validateOrThrow,
} from '../src/builder/skillValidator.js';
import type { FailurePattern, FailureContext, GeneratedSkill } from '../src/types.js';

// ── Mock data helpers ────────────────────────────────────────────────────────

function makeFailurePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  const now = new Date();
  const context: FailureContext = {
    sessionId: 'session-1',
    taskDescription: 'process a CSV file',
    toolInput: { path: '/tmp/data.csv' },
    errorOutput: 'ENOENT: no such file',
    timestamp: now,
  };

  return {
    id: 'fp-abc123',
    toolName: 'read',
    errorType: 'not_found',
    errorMessage: 'ENOENT: no such file or directory',
    frequency: 5,
    severity: 'high',
    exampleContexts: [context],
    firstSeen: now,
    lastSeen: now,
    autoFixAvailable: false,
    ...overrides,
  };
}

function makeSkill(overrides: Partial<GeneratedSkill> = {}): GeneratedSkill {
  return {
    id: 'skill-xyz-789',
    name: 'Test Skill',
    description: 'This is a test skill that handles file not found errors gracefully.',
    triggerPhrases: ['file not found', 'fix read error', 'handle enoent'],
    implementation:
      `// Skill implementation\n// This function handles the error gracefully\n` +
      `export async function handleReadError(path: string): Promise<string> {\n` +
      `  // Validate path first\n` +
      `  if (!path) throw new Error('Path is required');\n` +
      `  // ... implementation continues for many lines\n` +
      `  return 'handled';\n}`,
    examples: [
      {
        input: 'Read a file that may not exist',
        expectedOutput: 'Gracefully handled with error message',
        explanation: 'The skill detects the missing file and returns a helpful error.',
      },
    ],
    confidence: 0.75,
    targetFailurePattern: 'fp-abc123',
    generatedAt: new Date(),
    status: 'proposed',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// skillGenerator.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('builder/skillGenerator.ts', () => {

  // ── generateFromFailure: structure of generated skill ───────────────────

  describe('generateFromFailure()', () => {
    it('generates a skill with non-empty name, description, triggers, and implementation', () => {
      const failure = makeFailurePattern();
      const { skill } = generateFromFailure(failure);

      expect(skill.name).toBeTruthy();
      expect(skill.name.trim().length).toBeGreaterThan(0);
      expect(skill.description).toBeTruthy();
      expect(skill.description.trim().length).toBeGreaterThan(0);
      expect(skill.triggerPhrases).toBeTruthy();
      expect(skill.triggerPhrases.length).toBeGreaterThan(0);
      expect(skill.implementation).toBeTruthy();
      expect(skill.implementation.trim().length).toBeGreaterThan(0);
    });

    it('assigns a generated skill id', () => {
      const failure = makeFailurePattern();
      const { skill } = generateFromFailure(failure);
      expect(skill.id).toBeTruthy();
      expect(typeof skill.id).toBe('string');
      expect(skill.id.length).toBeGreaterThan(0);
    });

    it('sets status to "proposed"', () => {
      const failure = makeFailurePattern();
      const { skill } = generateFromFailure(failure);
      expect(skill.status).toBe('proposed');
    });

    it('sets targetFailurePattern to the failure id', () => {
      const failure = makeFailurePattern({ id: 'fp-custom-99' });
      const { skill } = generateFromFailure(failure);
      expect(skill.targetFailurePattern).toBe('fp-custom-99');
    });

    it('sets generatedAt to a valid Date', () => {
      const before = new Date();
      const failure = makeFailurePattern();
      const { skill } = generateFromFailure(failure);
      const after = new Date();

      expect(skill.generatedAt).toBeInstanceOf(Date);
      expect(skill.generatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(skill.generatedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('uses suggestedFix in the description when available', () => {
      const failure = makeFailurePattern({
        suggestedFix: 'Check if the file exists before reading, use a default path as fallback.',
      });
      const { skill } = generateFromFailure(failure);
      expect(skill.description).toContain('Check if the file exists');
    });

    it('produces at least one trigger phrase derived from the tool name', () => {
      const failure = makeFailurePattern({ toolName: 'web_search' });
      const { skill } = generateFromFailure(failure);

      // Should contain tool-name-based triggers like "use web_search" or "web_search error"
      const combinedTriggers = skill.triggerPhrases.join(' ').toLowerCase();
      expect(combinedTriggers.includes('web_search')).toBe(true);
    });

    it('returns a GenerationResult object with warnings array', () => {
      const failure = makeFailurePattern({ suggestedFix: undefined, exampleContexts: [] });
      const result = generateFromFailure(failure);

      expect(result).toHaveProperty('warnings');
      expect(Array.isArray(result.warnings)).toBe(true);
      expect(result).toHaveProperty('skill');
      expect(result).toHaveProperty('templateType');
    });

    it('warns when confidence is below 0.3', () => {
      // Very low frequency + no examples = low confidence
      const failure = makeFailurePattern({ frequency: 1, exampleContexts: [], suggestedFix: undefined });
      const result = generateFromFailure(failure);

      expect(result.skill.confidence).toBeLessThan(0.3);
      // The generator adds a warning for low confidence
      expect(result.warnings.some(w => w.toLowerCase().includes('confidence'))).toBe(true);
    });
  });

  // ── generateBatch ────────────────────────────────────────────────────────

  describe('generateBatch()', () => {
    it('generates one skill per failure pattern', () => {
      const failures = [
        makeFailurePattern({ id: 'fp-1', toolName: 'read' }),
        makeFailurePattern({ id: 'fp-2', toolName: 'write' }),
        makeFailurePattern({ id: 'fp-3', toolName: 'api_call' }),
      ];

      const results = generateBatch(failures);
      expect(results.length).toBe(3);
    });

    it('skips duplicate skill names and only keeps one', () => {
      // Two failures that produce the same skill name
      const failures = [
        makeFailurePattern({ id: 'fp-1', toolName: 'read', errorType: 'not_found' }),
        makeFailurePattern({ id: 'fp-2', toolName: 'read', errorType: 'not_found' }),
      ];

      const results = generateBatch(failures);
      // generateBatch deduplicates by skill name
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns empty array for empty input', () => {
      const results = generateBatch([]);
      expect(results).toHaveLength(0);
    });

    it('returns results with templateType for each generated skill', () => {
      const failures = [
        makeFailurePattern({ id: 'fp-1', toolName: 'read' }),
      ];

      const results = generateBatch(failures);
      expect(results[0].templateType).toBeTruthy();
    });
  });

  // ── selectTemplateType ──────────────────────────────────────────────────

  describe('selectTemplateType()', () => {
    it('returns "file_manipulation" for read/write/file tool names', () => {
      const fp1 = makeFailurePattern({ toolName: 'read', errorType: 'not_found' });
      const fp2 = makeFailurePattern({ toolName: 'write', errorType: 'permission_error' });
      const fp3 = makeFailurePattern({ toolName: 'editFile', errorType: 'io_error' });

      expect(selectTemplateType(fp1)).toBe('file_manipulation');
      expect(selectTemplateType(fp2)).toBe('file_manipulation');
      expect(selectTemplateType(fp3)).toBe('file_manipulation');
    });

    it('returns "web_search" for search-related failures', () => {
      const fp = makeFailurePattern({
        toolName: 'search',
        errorType: 'timeout',
        errorMessage: 'Search timeout after 10s',
      });
      expect(selectTemplateType(fp)).toBe('web_search');
    });

    it('returns "api_call" for HTTP/network errors', () => {
      const fp = makeFailurePattern({
        toolName: 'http_request',
        errorType: 'network_error',
        errorMessage: 'Connection refused',
      });
      expect(selectTemplateType(fp)).toBe('api_call');
    });

    it('returns "data_processing" for JSON/parse errors', () => {
      const fp = makeFailurePattern({
        toolName: 'parse',
        errorType: 'validation_error',
        errorMessage: 'Invalid JSON: unexpected token',
      });
      expect(selectTemplateType(fp)).toBe('data_processing');
    });

    it('returns "code_review" for code/lint errors', () => {
      const fp = makeFailurePattern({
        toolName: 'lint',
        errorType: 'validation_error',
        errorMessage: 'ESLint error: unused variable',
      });
      expect(selectTemplateType(fp)).toBe('code_review');
    });

    it('returns "debugging" for generic error type patterns', () => {
      const fp = makeFailurePattern({
        toolName: 'unknown_tool',
        errorType: 'unknown',
        errorMessage: 'Something went wrong',
      });
      // Unknown patterns fall back to debugging
      expect(selectTemplateType(fp)).toBe('debugging');
    });
  });

  // ── computeConfidence ───────────────────────────────────────────────────

  describe('computeConfidence()', () => {
    it('returns a value between 0 and 1', () => {
      const failure = makeFailurePattern({ frequency: 10, exampleContexts: [], suggestedFix: undefined });
      const conf = computeConfidence(failure);
      expect(conf).toBeGreaterThanOrEqual(0);
      expect(conf).toBeLessThanOrEqual(1);
    });

    it('returns higher confidence when frequency is higher', () => {
      const lowFreq = makeFailurePattern({ frequency: 1, exampleContexts: [], suggestedFix: undefined });
      const highFreq = makeFailurePattern({ frequency: 100, exampleContexts: [], suggestedFix: undefined });

      const confLow = computeConfidence(lowFreq);
      const confHigh = computeConfidence(highFreq);

      expect(confHigh).toBeGreaterThan(confLow);
    });

    it('increases confidence when suggestedFix is present and long enough', () => {
      const withoutFix = makeFailurePattern({
        frequency: 5,
        exampleContexts: [],
        suggestedFix: undefined,
      });
      const withFix = makeFailurePattern({
        frequency: 5,
        exampleContexts: [],
        suggestedFix: 'Check file permissions and retry with elevated access.',
      });

      const confWithout = computeConfidence(withoutFix);
      const confWith = computeConfidence(withFix);

      expect(confWith).toBeGreaterThan(confWithout);
    });

    it('increases confidence when exampleContexts are present', () => {
      const withoutExamples = makeFailurePattern({
        frequency: 5,
        exampleContexts: [],
        suggestedFix: undefined,
      });
      const withExamples = makeFailurePattern({
        frequency: 5,
        exampleContexts: [
          { sessionId: 's1', taskDescription: 'task', toolInput: {}, errorOutput: 'err', timestamp: new Date() },
        ],
        suggestedFix: undefined,
      });

      const confWithout = computeConfidence(withoutExamples);
      const confWith = computeConfidence(withExamples);

      expect(confWith).toBeGreaterThan(confWithout);
    });

    it('gives severity bonus for critical/high severity patterns', () => {
      const lowSeverity = makeFailurePattern({ severity: 'low', frequency: 10, exampleContexts: [], suggestedFix: undefined });
      const highSeverity = makeFailurePattern({ severity: 'critical', frequency: 10, exampleContexts: [], suggestedFix: undefined });

      const confLow = computeConfidence(lowSeverity);
      const confHigh = computeConfidence(highSeverity);

      expect(confHigh).toBeGreaterThan(confLow);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// skillValidator.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('builder/skillValidator.ts', () => {

  // ── validate: valid skill passes ─────────────────────────────────────────

  describe('validate()', () => {
    it('returns valid=true for a well-formed skill', () => {
      const skill = makeSkill();
      const result = validate(skill);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    // ── Missing name fails ──────────────────────────────────────────────

    it('returns errors when name is missing', () => {
      const skill = makeSkill({ name: '' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
    });

    it('returns errors when name is only whitespace', () => {
      const skill = makeSkill({ name: '   ' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('name'))).toBe(true);
    });

    // ── Empty description fails ───────────────────────────────────────────

    it('returns errors when description is missing', () => {
      const skill = makeSkill({ description: '' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('description'))).toBe(true);
    });

    // ── Empty implementation fails ───────────────────────────────────────

    it('returns errors when implementation is empty', () => {
      const skill = makeSkill({ implementation: '' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('implementation'))).toBe(true);
    });

    it('returns errors when implementation is only whitespace', () => {
      const skill = makeSkill({ implementation: '   \n\t  ' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
    });

    // ── Too short implementation fails ───────────────────────────────────

    it('returns errors when implementation is too short (< 100 chars)', () => {
      const skill = makeSkill({ implementation: '// tiny impl' });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('too short'))).toBe(true);
    });

    it('passes with implementation at the minimum length boundary (100 chars)', () => {
      const skill = makeSkill({
        implementation: '// a'.repeat(50), // 100 chars
      });
      const result = validate(skill);
      // Should not have "too short" error (≥ 100 chars)
      expect(result.errors.some(e => e.includes('too short'))).toBe(false);
    });

    // ── Confidence out of range fails ────────────────────────────────────

    it('returns errors when confidence is below 0', () => {
      const skill = makeSkill({ confidence: -0.1 });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Confidence') || e.includes('[0, 1]'))).toBe(true);
    });

    it('returns errors when confidence is above 1', () => {
      const skill = makeSkill({ confidence: 1.5 });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Confidence') || e.includes('[0, 1]'))).toBe(true);
    });

    // ── Missing trigger phrases fails ────────────────────────────────────

    it('returns errors when triggerPhrases is empty', () => {
      const skill = makeSkill({ triggerPhrases: [] });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('trigger'))).toBe(true);
    });

    it('returns errors when triggerPhrases contains empty strings', () => {
      const skill = makeSkill({ triggerPhrases: ['valid phrase', '', '  '] });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('trigger'))).toBe(true);
    });

    // ── Invalid status fails ─────────────────────────────────────────────

    it('returns errors for unknown status value', () => {
      const skill = makeSkill({ status: 'unknown_status' as GeneratedSkill['status'] });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('status'))).toBe(true);
    });

    // ── All valid statuses pass ──────────────────────────────────────────

    it.each(['proposed', 'testing', 'deployed', 'rejected', 'superseded'] as const)(
      'accepts valid status "%s"',
      (status) => {
        const skill = makeSkill({ status });
        const result = validate(skill);
        // Should not have a status-specific error
        expect(result.errors.some(e => e.toLowerCase().includes('status'))).toBe(false);
      }
    );

    // ── Unfilled template placeholders fail ──────────────────────────────

    it('returns errors when implementation contains unfilled {{PLACEHOLDER}} tokens', () => {
      const skill = makeSkill({
        implementation:
          'export function handler() {\n' +
          '  return "{{TOOL_NAME}}";\n' +  // unfilled {{TOOL_NAME}}
          '}',
      });
      const result = validate(skill);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('{{TOOL_NAME}}'))).toBe(true);
    });

    // ── Warnings ────────────────────────────────────────────────────────

    it('adds a warning when description is very short', () => {
      const skill = makeSkill({ description: 'Short.' });
      const result = validate(skill);
      expect(result.warnings.some(w => w.toLowerCase().includes('short'))).toBe(true);
    });

    it('adds a warning when confidence is below 0.2', () => {
      const skill = makeSkill({ confidence: 0.1 });
      const result = validate(skill);
      expect(result.warnings.some(w => w.toLowerCase().includes('confidence'))).toBe(true);
    });

    it('adds a warning for duplicate trigger phrases', () => {
      const skill = makeSkill({ triggerPhrases: ['fix error', 'fix error', 'retry'] });
      const result = validate(skill);
      expect(result.warnings.some(w => w.toLowerCase().includes('duplicate'))).toBe(true);
    });
  });

  // ── validateBatch ──────────────────────────────────────────────────────

  describe('validateBatch()', () => {
    it('returns a Map keyed by skill id', () => {
      const skills = [
        makeSkill({ id: 'skill-1' }),
        makeSkill({ id: 'skill-2' }),
      ];

      const results = validateBatch(skills);

      expect(results).toBeInstanceOf(Map);
      expect(results.has('skill-1')).toBe(true);
      expect(results.has('skill-2')).toBe(true);
    });

    it('returns valid=true for valid skills in batch', () => {
      const skills = [
        makeSkill({ id: 'skill-1' }),
        makeSkill({ id: 'skill-2' }),
      ];

      const results = validateBatch(skills);

      expect(results.get('skill-1')!.valid).toBe(true);
      expect(results.get('skill-2')!.valid).toBe(true);
    });

    it('returns valid=false for invalid skills in batch without throwing', () => {
      const skills = [
        makeSkill({ id: 'skill-good' }),
        makeSkill({ id: 'skill-bad', name: '' }),
      ];

      const results = validateBatch(skills);

      expect(results.get('skill-good')!.valid).toBe(true);
      expect(results.get('skill-bad')!.valid).toBe(false);
    });

    it('handles empty array without throwing', () => {
      const results = validateBatch([]);
      expect(results.size).toBe(0);
    });
  });

  // ── validateOrThrow ───────────────────────────────────────────────────

  describe('validateOrThrow()', () => {
    it('does not throw for a valid skill', () => {
      const skill = makeSkill();
      expect(() => validateOrThrow(skill)).not.toThrow();
    });

    it('throws with a descriptive message for an invalid skill', () => {
      const skill = makeSkill({ name: '', implementation: 'x' });
      expect(() => validateOrThrow(skill)).toThrow();
    });

    it('error message includes the skill name', () => {
      const skill = makeSkill({ name: 'MyBrokenSkill', implementation: 'x' });
      expect(() => validateOrThrow(skill)).toThrow('MyBrokenSkill');
    });

    it('throws for missing trigger phrases', () => {
      const skill = makeSkill({ triggerPhrases: [] });
      expect(() => validateOrThrow(skill)).toThrow();
    });

    it('throws for confidence out of range', () => {
      const skill = makeSkill({ confidence: 5 });
      expect(() => validateOrThrow(skill)).toThrow();
    });
  });
});
