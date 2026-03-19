/**
 * OpenClaw Evo — Skill Generator
 *
 * Generates new skills from failure pattern analysis.
 * Takes a FailurePattern, selects an appropriate template, fills in
 * placeholders, and returns a structured GeneratedSkill ready for
 * validation and deployment.
 */

import { randomUUID } from 'crypto';
import type {
  FailurePattern,
  GeneratedSkill,
  SkillExample,
  SkillTemplate,
} from '../types.js';

import {
  TEMPLATE_LIBRARY,
  getTemplate,
  getTemplateTypes,
  listTemplates,
} from './templateLibrary.js';

import { validate } from './skillValidator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export { TEMPLATE_LIBRARY, getTemplate, getTemplateTypes, listTemplates };

export interface GenerationOptions {
  /** Override the auto-selected template type */
  templateType?: string;
  /** Override the generated skill name */
  nameOverride?: string;
  /** Override the confidence score (bypasses auto-computation) */
  confidenceOverride?: number;
  /** Inject additional example contexts */
  extraExamples?: SkillExample[];
  /** Skip validation step (for testing / batch operations) */
  skipValidation?: boolean;
}

export interface GenerationResult {
  skill: GeneratedSkill;
  templateType: string;
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a new skill from a failure pattern.
 *
 * Process:
 *  1. Analyse the failure pattern and select the best-matching template type
 *  2. Fill in template placeholders with failure-specific data
 *  3. Generate trigger phrases from common patterns in the failure context
 *  4. Compute a confidence score based on frequency, fix clarity, and examples
 *  5. Validate the result (throws if invalid and skipValidation is false)
 */
export function generateFromFailure(
  failure: FailurePattern,
  options: GenerationOptions = {}
): GenerationResult {
  const warnings: string[] = [];

  // ── Step 1: Select template ────────────────────────────────────────────────
  const templateType = options.templateType ?? selectTemplateType(failure);
  const template = getTemplate(templateType);

  if (!template) {
    throw new Error(
      `[skillGenerator] Unknown template type "${templateType}". ` +
      `Available: ${Object.keys(TEMPLATE_LIBRARY).join(', ')}`
    );
  }

  // ── Step 2: Compute name ────────────────────────────────────────────────────
  const skillName = options.nameOverride ?? buildSkillName(failure);

  // ── Step 3: Compute description ────────────────────────────────────────────
  const description = buildDescription(failure);

  // ── Step 4: Compute trigger phrases ────────────────────────────────────────
  const triggerPhrases = buildTriggerPhrases(failure, template);

  // ── Step 5: Fill template placeholders ────────────────────────────────────
  const implementation = fillTemplate(template, failure, triggerPhrases, description);

  // ── Step 6: Build examples ─────────────────────────────────────────────────
  const examples = buildExamples(failure, template, options.extraExamples);

  // ── Step 7: Compute confidence score ───────────────────────────────────────
  const confidence = options.confidenceOverride ?? computeConfidence(failure);

  if (confidence < 0.3) {
    warnings.push(
      `Low confidence score (${(confidence * 100).toFixed(0)}%) for "${failure.errorType}" — ` +
      'consider adding more example contexts to improve quality.'
    );
  }

  // ── Step 8: Assemble skill ─────────────────────────────────────────────────
  const skill: GeneratedSkill = {
    id: randomUUID(),
    name: skillName,
    description,
    triggerPhrases,
    implementation,
    examples,
    confidence,
    targetFailurePattern: failure.id,
    generatedAt: new Date(),
    status: 'proposed',
  };

  // ── Step 9: Validate ───────────────────────────────────────────────────────
  if (!options.skipValidation) {
    const result = validate(skill);
    if (!result.valid) {
      throw new Error(
        `[skillGenerator] Generated skill "${skillName}" failed validation:\n` +
        result.errors.map(e => `  - ${e}`).join('\n')
      );
    }
  }

  console.info(
    `[skillGenerator] Generated skill "${skillName}" ` +
    `(confidence: ${(confidence * 100).toFixed(0)}%, ` +
    `template: ${templateType}, ` +
    `pattern: ${failure.errorType})`
  );

  return { skill, templateType, warnings };
}

/**
 * Generate multiple skills from a batch of failure patterns.
 * Skips patterns that produce duplicate skill names.
 */
export function generateBatch(
  failures: FailurePattern[],
  options: GenerationOptions = {}
): GenerationResult[] {
  const results: GenerationResult[] = [];
  const seenNames = new Set<string>();

  for (const failure of failures) {
    try {
      const result = generateFromFailure(failure, { ...options, skipValidation: true });

      if (seenNames.has(result.skill.name)) {
        console.warn(
          `[skillGenerator] Skipping duplicate skill "${result.skill.name}" ` +
          `for pattern ${failure.id}`
        );
        continue;
      }

      // Validate after batch deduplication
      const validation = validate(result.skill);
      if (!validation.valid) {
        console.warn(
          `[skillGenerator] Skill "${result.skill.name}" failed validation in batch: ` +
          validation.errors.join('; ')
        );
        continue;
      }

      seenNames.add(result.skill.name);
      results.push(result);
    } catch (error) {
      console.error(
        `[skillGenerator] Failed to generate skill for pattern ${failure.id}: ` +
        (error instanceof Error ? error.message : String(error))
      );
    }
  }

  console.info(`[skillGenerator] Batch complete: ${results.length}/${failures.length} skills generated`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select the best-matching template type for a given failure pattern.
 *
 * Strategy:
 *  - Match on error type keywords and tool name
 *  - Fall back to a generic template if no strong match
 */
export function selectTemplateType(failure: FailurePattern): string {
  const { toolName, errorType, errorMessage } = failure;
  const combined = `${toolName} ${errorType} ${errorMessage}`.toLowerCase();

  // Keyword → template mapping
  const keywordMap: Array<[RegExp | string, string]> = [
    // File operations
    [/file|path|read|write|edit/i, 'file_manipulation'],

    // Network / HTTP
    [/http|request|fetch|api|rest|graphql|url|connection/i, 'api_call'],

    // Search
    [/search|google|look up|web search/i, 'web_research'],

    // Data formats
    [/json|parse|csv|xml|transform|encode|decode/i, 'data_processing'],

    // Code analysis
    [/code|review|lint|static|audit/i, 'code_debug'],

    // Debugging / errors
    [/error|exception|debug|trace|stack|fail|diagnos/i, 'code_debug'],
  ];

  for (const [keyword, template] of keywordMap) {
    if (typeof keyword === 'string') {
      if (combined.includes(keyword)) return template;
    } else {
      if (keyword.test(combined)) return template;
    }
  }

  // Tool-name heuristics (tool names often encode their domain)
  const toolNameLower = toolName.toLowerCase();
  if (toolNameLower.includes('file') || toolNameLower.includes('read') || toolNameLower.includes('write')) {
    return 'file_manipulation';
  }
  if (toolNameLower.includes('http') || toolNameLower.includes('request') || toolNameLower.includes('fetch')) {
    return 'api_call';
  }
  if (toolNameLower.includes('search')) return 'web_research';

  // Default fallback — Code Debug is the most generic and covers unknown patterns
  return 'code_debug';
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence scoring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a confidence score (0–1) for the generated skill.
 *
 * Factors:
 *  - frequency: how many times this pattern has occurred
 *  - clarity of fix: suggestedFix is present and non-trivial
 *  - example availability: exampleContexts are populated
 *  - severity: higher severity patterns get slightly higher confidence
 *    (they are worth investing in)
 */
export function computeConfidence(failure: FailurePattern): number {
  const { frequency, suggestedFix, exampleContexts, severity } = failure;

  // Frequency factor: log-scale, capped at 0.3
  // 1 occurrence → ~0.1, 10 → ~0.2, 100+ → 0.3
  const freqFactor = Math.min(0.3, Math.log10(Math.max(1, frequency) + 1) * 0.15);

  // Fix clarity: has a non-empty suggested fix → +0.25
  const fixFactor = suggestedFix && suggestedFix.trim().length > 10 ? 0.25 : 0;

  // Example factor: has at least one context → +0.25, more contexts → +0.35
  const exampleFactor = exampleContexts.length === 0
    ? 0
    : exampleContexts.length === 1
    ? 0.25
    : 0.35;

  // Severity bonus: critical/high → +0.1, medium → +0.05
  const severityBonus = severity === 'critical' || severity === 'high' ? 0.1 : severity === 'medium' ? 0.05 : 0;

  return Math.min(1, Math.max(0, freqFactor + fixFactor + exampleFactor + severityBonus));
}

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder filling
// ─────────────────────────────────────────────────────────────────────────────

function fillTemplate(
  template: SkillTemplate,
  failure: FailurePattern,
  triggerPhrases: string[],
  description: string,
): string {
  const toolNameUpper = failure.toolName.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const toolNameCamel = toCamelCase(failure.toolName);
  const triggersMd = triggerPhrases.map(p => `- ${p}`).join('\n');

  // Extract error type without namespace
  const errorTypeShort = failure.errorType.replace(/^[\w]+\//, '').replace(/_/g, ' ');

  return template.implementationTemplate
    .replace(/\{\{TOOL_NAME\}\}/g, failure.toolName)
    .replace(/\{\{TOOL_NAME_UPPER\}\}/g, toolNameUpper)
    .replace(/\{\{TOOL_NAME_CAMEL\}\}/g, toolNameCamel)
    .replace(/\{\{DESCRIPTION\}\}/g, description)
    .replace(/\{\{ERROR_TYPE\}\}/g, errorTypeShort)
    .replace(/\{\{TRIGGERS\}\}/g, triggersMd)
    .replace(
      /\{\{EXAMPLE_IMPLEMENTATION\}\}/g,
      buildExampleMarkdown(failure, template)
    );
}

function buildExampleMarkdown(
  failure: FailurePattern,
  template: SkillTemplate,
): string {
  const { exampleTemplate } = template;
  const firstContext = failure.exampleContexts[0];

  return `
### Example

**Input:** ${exampleTemplate.input}
${firstContext ? `\n**Context:** ${firstContext.taskDescription}\n` : ''}
**Expected output:** ${exampleTemplate.expectedOutput}

${exampleTemplate.explanation}
`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Trigger phrase generation
// ─────────────────────────────────────────────────────────────────────────────

function buildTriggerPhrases(failure: FailurePattern, template: SkillTemplate): string[] {
  const base = template.triggerPhrases.map(p => p.toLowerCase());

  // Extract meaningful keywords from the error type / message
  const errorWords = extractKeywords(`${failure.errorType} ${failure.errorMessage}`);

  // Phrases derived from the tool name
  const toolPhrases = [
    `use ${failure.toolName}`,
    `call ${failure.toolName}`,
    `run ${failure.toolName}`,
    `${failure.toolName} error`,
    `${failure.toolName} failed`,
  ];

  // Phrases derived from the error
  const errorPhrases = errorWords.slice(0, 3).map(word => [
    `${word} error`,
    `fix ${word}`,
    `${word} problem`,
    `handle ${word}`,
  ]).flat();

  // Phrase derived from suggested fix
  const fixPhrases = failure.suggestedFix
    ? extractKeywords(failure.suggestedFix).slice(0, 2).map(word => `fix ${word}`)
    : [];

  const all = [
    ...new Set([...base, ...toolPhrases, ...errorPhrases, ...fixPhrases]),
  ];

  // Deduplicate and cap at 10 phrases
  return all.slice(0, 10);
}

function extractKeywords(text: string): string[] {
  // Drop common stop words and short tokens, return unique meaningful words
  const stopWords = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'but',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
    'this', 'that', 'these', 'those', 'it', 'its', 'with', 'from', 'as',
    'null', 'undefined', 'error', 'failed', 'failure', 'cannot', 'could not',
    'unable', 'invalid', 'not', 'no',
  ]);

  return [...new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w))
  )];
}

// ─────────────────────────────────────────────────────────────────────────────
// Description & name
// ─────────────────────────────────────────────────────────────────────────────

function buildSkillName(failure: FailurePattern): string {
  const tool = failure.toolName.replace(/[^a-zA-Z0-9]/g, '');
  const error = failure.errorType
    .replace(/^[\w]+\//, '')        // drop namespace
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  return `${tool} — ${error} Skill`.trim();
}

function buildDescription(failure: FailurePattern): string {
  const errorTypeShort = failure.errorType
    .replace(/^[\w]+\//, '')
    .replace(/_/g, ' ');

  let desc = `Handles ${errorTypeShort} errors for the ${failure.toolName} tool. `;

  if (failure.suggestedFix) {
    // Truncate fix hint to avoid overly long descriptions
    const fixHint = failure.suggestedFix.slice(0, 120);
    desc += `Fix strategy: ${fixHint}${failure.suggestedFix.length > 120 ? '…' : ''}`;
  } else {
    desc += 'Automatically generated from failure pattern analysis.';
  }

  return desc;
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples
// ─────────────────────────────────────────────────────────────────────────────

function buildExamples(
  failure: FailurePattern,
  template: SkillTemplate,
  extra?: SkillExample[],
): SkillExample[] {
  const examples: SkillExample[] = [
    {
      input: template.exampleTemplate.input,
      expectedOutput: template.exampleTemplate.expectedOutput,
      explanation: template.exampleTemplate.explanation,
    },
  ];

  // Use first few example contexts from the failure pattern
  const fromContexts = failure.exampleContexts.slice(0, 2).map(ctx => ({
    input: ctx.taskDescription,
    expectedOutput: `Successfully handled ${failure.errorType} error in ${failure.toolName}`,
    explanation: `Context from session ${ctx.sessionId}: ${ctx.toolInput ? JSON.stringify(ctx.toolInput).slice(0, 100) : 'no additional context'}`,
  }));

  return extra ? [...examples, ...fromContexts, ...extra] : [...examples, ...fromContexts];
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, c => c.toLowerCase());
}
