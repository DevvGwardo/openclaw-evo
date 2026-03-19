/**
 * OpenClaw Evo — Builder Module
 *
 * Re-exports all builder submodules for convenient access.
 *
 * Modules:
 *   templateLibrary — SKILL.md templates for common skill types
 *   skillGenerator  — Generate new skills from failure patterns
 *   skillValidator — Validate generated skill structure
 */

// Template library — SKILL.md templates for common skill types
export {
  TEMPLATE_LIBRARY,
  getTemplate,
  getTemplateTypes,
  listTemplates,
} from './templateLibrary.js';

// Skill generator — create GeneratedSkill from FailurePattern
export {
  generateFromFailure,
  generateBatch,
  selectTemplateType,
  computeConfidence,
} from './skillGenerator.js';

// Skill validator — validate GeneratedSkill structure before proposing
export {
  validate,
  validateBatch,
  validateOrThrow,
  validateExamples,
  type ValidationResult,
} from './skillValidator.js';
