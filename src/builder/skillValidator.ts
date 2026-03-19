/**
 * OpenClaw Evo — Skill Validator
 *
 * Validates GeneratedSkill structure before it is proposed or deployed.
 * Runs structural, content, and consistency checks and returns a
 * structured result so callers can act on individual failure reasons.
 */

import type { GeneratedSkill, SkillExample } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Result types
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Batch-validate an array of skills.
 * Returns a map of skill id → result for easy inspection.
 */
export function validateBatch(skills: GeneratedSkill[]): Map<string, ValidationResult> {
  const results = new Map<string, ValidationResult>();
  for (const skill of skills) {
    results.set(skill.id, validate(skill));
  }
  return results;
}

/**
 * Validate a skill and throw if it is invalid.
 * Useful for guard-at-entrypoint patterns.
 */
export function validateOrThrow(skill: GeneratedSkill): void {
  const result = validate(skill);
  if (!result.valid) {
    throw new Error(
      `[skillValidator] Skill "${skill.name}" (${skill.id}) is invalid:\n` +
      result.errors.map(e => `  ✗ ${e}`).join('\n') +
      (result.warnings.length > 0
        ? '\n' + result.warnings.map(w => `  ⚠ ${w}`).join('\n')
        : '')
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a GeneratedSkill.
 *
 * Checks performed:
 *  - has non-empty name
 *  - has non-empty description
 *  - has at least one trigger phrase
 *  - implementation is non-empty and within reasonable length bounds
 *  - trigger phrases are unique
 *  - confidence score is in [0, 1]
 *  - examples are well-formed (when present)
 *  - status is a known enum value
 */
export function validate(skill: GeneratedSkill): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ── Identity checks ────────────────────────────────────────────────────────

  if (!skill.id || skill.id.trim().length === 0) {
    errors.push('Skill is missing an id');
  }

  if (!skill.name || skill.name.trim().length === 0) {
    errors.push('Skill is missing a name');
  } else if (skill.name.length > 120) {
    errors.push(`Skill name is too long (${skill.name.length} chars, max 120): "${skill.name}"`);
  }

  // ── Description checks ──────────────────────────────────────────────────────

  if (!skill.description || skill.description.trim().length === 0) {
    errors.push('Skill is missing a description');
  } else if (skill.description.length < 20) {
    warnings.push(
      `Skill description is very short (${skill.description.length} chars) — ` +
      'it may not clearly convey the skill purpose.'
    );
  }

  // ── Trigger phrases checks ─────────────────────────────────────────────────

  if (!skill.triggerPhrases || skill.triggerPhrases.length === 0) {
    errors.push('Skill must have at least one trigger phrase');
  } else {
    if (skill.triggerPhrases.some(p => !p || p.trim().length === 0)) {
      errors.push('Trigger phrases contains empty or blank entries');
    }

    const unique = new Set(skill.triggerPhrases.map(p => p.toLowerCase().trim()));
    if (unique.size < skill.triggerPhrases.length) {
      warnings.push('Trigger phrases contain duplicates — consider deduplicating');
    }

    if (skill.triggerPhrases.length > 20) {
      warnings.push(
        `Skill has ${skill.triggerPhrases.length} trigger phrases — ` +
        'more than 20 may reduce matching precision. Consider pruning low-value phrases.'
      );
    }

    // Warn if any trigger is too short (likely noise)
    const shortTriggers = skill.triggerPhrases.filter(p => p.trim().length < 3);
    if (shortTriggers.length > 0) {
      warnings.push(
        `Trigger phrases "${shortTriggers.join('", "')}" are very short and ` +
        'may match too broadly.'
      );
    }
  }

  // ── Implementation checks ───────────────────────────────────────────────────

  if (!skill.implementation || skill.implementation.trim().length === 0) {
    errors.push('Skill is missing an implementation');
  } else {
    const implLen = skill.implementation.trim().length;

    if (implLen < 100) {
      errors.push(
        `Implementation is too short (${implLen} chars, min 100) — ` +
        'it likely does not contain meaningful functionality.'
      );
    } else if (implLen > 50_000) {
      errors.push(
        `Implementation is too long (${implLen} chars, max 50,000) — ` +
        'it may be unmanageable. Consider splitting into helper modules.'
      );
    } else if (implLen < 500) {
      warnings.push(
        `Implementation is short (${implLen} chars) — ` +
        'verify it contains sufficient logic and error handling.'
      );
    }

    // Placeholder hygiene: warn about unfilled template markers
    const unfilledPlaceholders = detectUnfilledPlaceholders(skill.implementation);
    if (unfilledPlaceholders.length > 0) {
      errors.push(
        `Implementation contains unfilled placeholders: ` +
        `"${unfilledPlaceholders.join('", "')}"`
      );
    }

    // Warn about suspicious placeholder syntax (not replaced)
    const rawPlaceholders = skill.implementation.match(/\{\{[^}]+\}\}/g);
    if (rawPlaceholders && rawPlaceholders.length > 0) {
      // Only warn if not already caught as unfilled (some may be intentional code strings)
      if (unfilledPlaceholders.length === 0) {
        warnings.push(
          `Implementation contains raw template placeholders ` +
          `(${rawPlaceholders.length} found): ${rawPlaceholders.slice(0, 3).join(', ')}${rawPlaceholders.length > 3 ? '…' : ''} — ` +
          'ensure these are intentional string literals, not unfilled template markers.'
        );
      }
    }
  }

  // ── Confidence score checks ─────────────────────────────────────────────────

  if (typeof skill.confidence !== 'number') {
    errors.push(`Confidence must be a number, got: ${typeof skill.confidence}`);
  } else {
    if (skill.confidence < 0 || skill.confidence > 1) {
      errors.push(`Confidence must be in [0, 1], got: ${skill.confidence}`);
    }
    if (skill.confidence < 0.2) {
      warnings.push(
        `Low confidence score (${(skill.confidence * 100).toFixed(0)}%) — ` +
        'this skill may not reliably fix the target failure pattern.'
      );
    }
  }

  // ── Examples checks ─────────────────────────────────────────────────────────

  if (skill.examples && skill.examples.length > 0) {
    const exampleErrors = validateExamples(skill.examples);
    errors.push(...exampleErrors.map(e => `Example: ${e}`));
  }

  // ── Status checks ───────────────────────────────────────────────────────────

  const VALID_STATUSES: GeneratedSkill['status'][] = [
    'proposed', 'testing', 'deployed', 'rejected', 'superseded',
  ];

  if (!skill.status || !VALID_STATUSES.includes(skill.status)) {
    errors.push(
      `Invalid status "${skill.status}". Must be one of: ${VALID_STATUSES.join(', ')}`
    );
  }

  // ── Generated timestamp checks ─────────────────────────────────────────────

  if (!skill.generatedAt || !(skill.generatedAt instanceof Date) && isNaN(Date.parse(skill.generatedAt as unknown as string))) {
    warnings.push('Skill is missing a valid generatedAt timestamp');
  }

  // ── Target pattern check ────────────────────────────────────────────────────

  if (!skill.targetFailurePattern || skill.targetFailurePattern.trim().length === 0) {
    warnings.push('Skill has no targetFailurePattern — it may be a generic skill without a specific failure origin');
  }

  const valid = errors.length === 0;

  if (valid) {
    console.debug(`[skillValidator] ✓ Skill "${skill.name}" passed validation`);
  } else {
    console.warn(
      `[skillValidator] ✗ Skill "${skill.name}" failed validation with ${errors.length} error(s)`
    );
  }

  return { valid, errors, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate an array of SkillExample objects.
 * Returns a list of error messages (empty if all are valid).
 */
export function validateExamples(examples: SkillExample[]): string[] {
  const errors: string[] = [];

  for (let i = 0; i < examples.length; i++) {
    const ex = examples[i];

    if (!ex.input || ex.input.trim().length === 0) {
      errors.push(`Example[${i}]: missing or empty input`);
    }

    if (!ex.expectedOutput || ex.expectedOutput.trim().length === 0) {
      errors.push(`Example[${i}]: missing or empty expectedOutput`);
    }

    if (!ex.explanation || ex.explanation.trim().length === 0) {
      errors.push(`Example[${i}]: missing or empty explanation`);
    }

    if (ex.input && ex.input.length > 1000) {
      errors.push(`Example[${i}]: input is very long (${ex.input.length} chars) — consider shortening`);
    }
  }

  // Warn if no examples at all
  if (examples.length === 0) {
    errors.push('Skill has no examples — examples significantly improve skill quality and testability');
  }

  return errors;
}

/**
 * Detect common unfilled template placeholder patterns.
 * Returns a list of placeholder tokens that look like they weren't replaced.
 */
function detectUnfilledPlaceholders(impl: string): string[] {
  // Match {{UPPER_SNAKE}}, {{lowerCamel}}, {{words with spaces}}, etc.
  // but exclude obvious code strings that legitimately contain {{ or }}
  const placeholderPattern = /\{\{([A-Z_][A-Z0-9_]*)\}\}|\{\{([a-z][a-z0-9]*)\}\}|\{\{([^}]{3,80})\}\}/g;
  const found: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = placeholderPattern.exec(impl)) !== null) {
    const token = match[0];
    // Known placeholder names that are intentionally left as-is (code examples)
    const codeLiterals = ['console.log', 'JSON.parse', 'Error:', 'null', 'undefined'];
    if (!codeLiterals.some(lit => impl.slice(Math.max(0, match!.index - 20), match!.index + token.length).includes(`'${lit}'`))) {
      found.push(token);
    }
  }

  return found;
}
