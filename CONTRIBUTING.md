# Contributing to OpenClaw Evo

Thank you for your interest in contributing! Here's everything you need to know to get started.

## Adding New Templates

Templates live in `src/templates/` (or equivalent). To add a new one:

1. Create a new directory under the templates folder, e.g. `src/templates/my-template/`.
2. Add at minimum two files:
   - `template.md` — the template content with placeholder tokens like `{{variable}}`.
   - `schema.json` — a JSON schema describing required variables and their types.
3. Export the template in `src/templates/index.ts`.
4. Add a test (see below).

## Creating Tests

All new templates and core logic should have tests:

- Unit tests live in `tests/` using a framework like **Jest** or **Vitest**.
- Run tests locally before submitting: `npm test`

Example test structure:

```typescript
import { describe, it, expect } from 'vitest';
import { myTemplate } from '../src/templates/my-template';

describe('my-template', () => {
  it('renders with required variables', () => {
    const result = myTemplate.render({ name: 'Alice', goal: 'ship it' });
    expect(result).toContain('Alice');
    expect(result).toContain('ship it');
  });

  it('throws on missing required variables', () => {
    expect(() => myTemplate.render({})).toThrow();
  });
});
```

## Submitting Pull Requests

1. **Fork the repo** and create a branch:
   ```bash
   git checkout -b feat/my-new-template
   ```

2. **Make your changes** — add the template, update tests, update docs.

3. **Ensure tests pass:**
   ```bash
   npm test
   npm run build
   ```

4. **Commit with a clear message:**
   ```bash
   git commit -m "feat(templates): add my-new-template for X"
   ```

5. **Open a PR** against `main`. Include:
   - A short description of what the template does.
   - Any new environment variables or secrets required (add them to `.env.example`).
   - Screenshots or output examples if applicable.

6. PRs are reviewed within a few days. Minor fixes may be fast-tracked.

## Code Style

- Use **TypeScript** throughout.
- Run `npm run lint` and fix any warnings before submitting.
- Keep templates readable — use comments for complex placeholder logic.

## Questions?

Open an issue or reach out via the repo's discussion board. Happy to help you get your template merged!
