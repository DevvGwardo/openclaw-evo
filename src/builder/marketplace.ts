export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  author: string;
  downloads: number;
  rating: number;
  source: string;
}

export interface GeneratedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  category: string;
}

const MARKETPLACE_SKILLS: MarketplaceSkill[] = [
  {
    id: "adv-git-workflow",
    name: "Advanced Git Workflow",
    description: "Complex git operations including interactive rebase, bisect, worktrees, submodules, and advanced merge strategies.",
    category: "shell",
    author: "openclaw",
    downloads: 12400,
    rating: 4.8,
    source: "builtin",
  },
  {
    id: "api-rate-limit-handler",
    name: "API Rate Limit Handler",
    description: "Sophisticated retry logic with exponential backoff, jitter, and circuit breaker patterns for resilient API integrations.",
    category: "api",
    author: "openclaw",
    downloads: 9800,
    rating: 4.7,
    source: "builtin",
  },
  {
    id: "db-migration-helper",
    name: "Database Migration Helper",
    description: "SQL migration scripts with up/down versioning, rollback support, and schema diff generation for PostgreSQL and SQLite.",
    category: "data",
    author: "openclaw",
    downloads: 7600,
    rating: 4.6,
    source: "builtin",
  },
  {
    id: "container-debugger",
    name: "Container Debugger",
    description: "Docker and Kubernetes debugging with log analysis, resource inspection, shell injection, and network troubleshooting.",
    category: "debug",
    author: "openclaw",
    downloads: 11200,
    rating: 4.9,
    source: "builtin",
  },
  {
    id: "security-scanner",
    name: "Security Scanner",
    description: "Basic security checks including dependency vulnerability scanning, secret detection, and misconfiguration alerts.",
    category: "debug",
    author: "openclaw",
    downloads: 8900,
    rating: 4.5,
    source: "builtin",
  },
];

export function getFeaturedSkills(): MarketplaceSkill[] {
  return [...MARKETPLACE_SKILLS];
}

export function searchSkills(query: string): MarketplaceSkill[] {
  const q = query.toLowerCase();
  return MARKETPLACE_SKILLS.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
  );
}

export function installFromMarketplace(id: string): GeneratedSkill | null {
  const skill = MARKETPLACE_SKILLS.find((s) => s.id === id);
  if (!skill) return null;

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    instructions: skill.description,
    category: skill.category,
  };
}
