/**
 * Curated, in-repo guidance packs.
 *
 * Everything here is static data compiled into `dist/`; selection and rendering
 * never read files, call models, or inspect the host. Pack contents are derived
 * from AGENTS.md, docs/decisions.md, docs/security-model.md, and
 * CONTRIBUTING.md. Bump a pack's `version` whenever its rules change.
 */

import type { GuidancePack, GuidanceRule } from './types.ts';

export const BASE_PACK_ID = 'typescript-base';

interface PackInput {
  id: string;
  version: string;
  area: GuidancePack['area'];
  title: string;
  summary: string;
  rules: readonly GuidanceRule[];
  keywords: readonly string[];
  pathHints: readonly string[];
}

function definePack(input: PackInput): GuidancePack {
  return Object.freeze({
    id: input.id,
    version: input.version,
    area: input.area,
    title: input.title,
    summary: input.summary,
    rules: Object.freeze(
      input.rules.map((rule) =>
        Object.freeze({
          id: rule.id,
          text: rule.text,
          source: rule.source,
        }),
      ),
    ),
    keywords: Object.freeze([...input.keywords]),
    pathHints: Object.freeze([...input.pathHints]),
  });
}

const TYPESCRIPT_BASE = definePack({
  id: BASE_PACK_ID,
  version: '1.0.0',
  area: 'typescript',
  title: 'TypeScript base discipline',
  summary:
    'Strict ESM TypeScript, compiled tests, and the repository dependency boundary.',
  rules: [
    {
      id: 'ts-strict-esm',
      text: 'Use strict TypeScript ESM on Node 26 in a single npm package; do not add a second language or build system.',
      source: 'docs/decisions.md #4',
    },
    {
      id: 'ts-explicit-extensions',
      text: 'Use relative imports with explicit `.ts` extensions; compiled JavaScript is what harnesses load.',
      source: 'AGENTS.md Commands',
    },
    {
      id: 'ts-rebuild',
      text: 'Run the build after TypeScript changes; tests execute compiled files under `dist/`, not TypeScript sources.',
      source: 'AGENTS.md Commands',
    },
    {
      id: 'ts-node-test',
      text: 'Write tests with the built-in `node:test` runner and keep test files compiled to `dist/`; do not add a separate TS test runner.',
      source: 'AGENTS.md Tests',
    },
    {
      id: 'ts-narrow-types',
      text: 'Prefer explicit, narrow types and validated inputs over unchecked casts, `any`, or implicit trust in caller data.',
      source: 'tsconfig.json strict',
    },
    {
      id: 'ts-no-new-frameworks',
      text: 'Do not introduce web frameworks, ORMs, LLM SDKs, expression evaluators, or unapproved runtime dependencies.',
      source: 'docs/decisions.md #5',
    },
  ],
  keywords: [
    'typescript',
    'esm',
    'tsc',
    'typecheck',
    'strict',
    'node test',
    'import',
    'extension',
    'dist',
  ],
  pathHints: [],
});

const ENGINE = definePack({
  id: 'engine-core',
  version: '1.0.0',
  area: 'engine',
  title: 'Deterministic engine',
  summary:
    'Pure evaluation, fail-closed precedence, frozen predicates, and a policy source that stays outside the hot path.',
  rules: [
    {
      id: 'engine-pure',
      text: 'Keep `engine/` pure: no filesystem, network, model, harness, or wall-clock I/O; accept an injected clock.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'engine-precedence',
      text: 'Preserve `deny > confirm > log > allow` including same-tier deny, and keep evaluation fail-closed.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'engine-frozen-operators',
      text: 'The seven predicate operators are frozen; do not add regex routing, custom DSLs, or one-off operators.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'engine-verdict-fields',
      text: 'Only `predicate`, `on_hit`, and `ttl` affect verdicts; `scope`, `owner`, `level`, `policy_class`, and `enforcement` are validated metadata.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'engine-loader-validation',
      text: 'Keep schema and vocabulary validation in the loader; the verdict hot path reads an immutable in-memory snapshot.',
      source: 'docs/decisions.md #3, #6',
    },
    {
      id: 'engine-lexical-targets',
      text: 'File targets are lexically normalized absolute paths; do not add realpath or TOCTOU claims to the hot path.',
      source: 'AGENTS.md Architecture invariants',
    },
  ],
  keywords: [
    'engine',
    'verdict',
    'verdicts',
    'predicate',
    'predicates',
    'rules yaml',
    'snapshot',
    'snapshots',
    'fail closed',
    'deny',
    'confirm',
    'precedence',
    'injected clock',
  ],
  pathHints: ['engine', 'constraints'],
});

const ADAPTERS = definePack({
  id: 'adapters',
  version: '1.1.0',
  area: 'adapters',
  title: 'Harness adapters',
  summary:
    'Adapter-owned normalization, log-only behavior, bounded logging, and honest coverage of unsupported actions.',
  rules: [
    {
      id: 'adapters-own-normalization',
      text: 'Adapters own harness payload normalization; keep harness-specific shapes out of the engine and shared core.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'adapters-log-only',
      text: 'Security policy is Stage A log-only with hypothetical verdicts. A separate opt-in workflow gate may block or hold work; never conflate them.',
      source: 'AGENTS.md Current security boundary',
    },
    {
      id: 'adapters-no-sensitive-logs',
      text: 'Never log file contents, shell command text, URL secret values, credentials, or raw hostile payloads.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'adapters-coverage',
      text: 'Record explicit coverage (`unknown_payload`, `not_evaluated`) for unsupported or opaque actions; never silently skip them.',
      source: 'docs/decisions.md Current implementation constraints',
    },
    {
      id: 'adapters-per-harness-lifecycle',
      text: 'Keep deny, confirm, permission UI, and event lifecycle per harness; do not build a model-provider abstraction or add a third harness.',
      source: 'docs/decisions.md Current implementation constraints',
    },
  ],
  keywords: [
    'adapter',
    'adapters',
    'opencode',
    'pi',
    'hook',
    'hooks',
    'normalize',
    'normalization',
    'payload',
    'payloads',
    'harness',
    'harnesses',
  ],
  pathHints: ['adapters'],
});

const SUPERVISOR = definePack({
  id: 'supervisor-core',
  version: '1.0.0',
  area: 'supervisor',
  title: 'Supervisor core',
  summary:
    'Process-local session state and fences that are not approvals, capabilities, or a trust boundary.',
  rules: [
    {
      id: 'supervisor-in-memory',
      text: 'Treat `supervisor/` as an in-memory session, decision, and stop core; it is not a running trust boundary.',
      source: 'docs/supervisor-core.md',
    },
    {
      id: 'supervisor-process-local-fences',
      text: 'Fences rely on process-local object identity; they do not survive IPC and must not be serialized as tokens.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'supervisor-not-authorization',
      text: 'Never describe a fence, epoch, or supervisor decision as an approval or execution authorization.',
      source: 'docs/supervisor-core.md',
    },
    {
      id: 'supervisor-coverage-ineligible',
      text: 'Coverage results remain hypothetical and are never eligible for confirmation.',
      source: 'supervisor/core.ts',
    },
    {
      id: 'supervisor-deterministic',
      text: 'Delegate verdicts to the deterministic engine and keep I/O, models, and harness calls outside the core.',
      source: 'docs/supervisor-core.md',
    },
  ],
  keywords: [
    'supervisor',
    'session',
    'sessions',
    'fence',
    'fences',
    'epoch',
    'coverage',
    'stop',
    'stopped',
    'process local',
  ],
  pathHints: ['supervisor'],
});

const DECISION = definePack({
  id: 'decision-jev',
  version: '1.0.0',
  area: 'decision',
  title: 'Decision model and Jev',
  summary:
    'A semantic sensor that can only tighten deterministic verdicts, with strict egress and fail-closed uncertainty.',
  rules: [
    {
      id: 'decision-engine-authoritative',
      text: 'The deterministic engine stays authoritative; Jev is an optional semantic sensor that may tighten but never relax a verdict.',
      source: 'docs/decisions.md #11',
    },
    {
      id: 'decision-fail-closed',
      text: 'When policy requires an assessment, model failure, refusal, timeout, or low confidence must fail closed.',
      source: 'docs/security-model.md Decision-model integration',
    },
    {
      id: 'decision-strict-egress',
      text: 'Send only the sanitized action projection: no file contents, shell text, URL secrets, credentials, userinfo, or fragments.',
      source: 'AGENTS.md Architecture invariants',
    },
    {
      id: 'decision-context-not-redacted',
      text: 'Caller-supplied context is not automatically redacted; redact it at the call site before assessment.',
      source: 'decision/types.ts',
    },
    {
      id: 'decision-no-fallback',
      text: 'Use an explicit default model and allowlist; never fall back automatically to another model or provider.',
      source: 'workflow gate constraints',
    },
    {
      id: 'decision-human-confirmation',
      text: 'Engineering concerns raised by a model require human confirmation; they do not approve or block work by themselves.',
      source: 'workflow gate constraints',
    },
  ],
  keywords: [
    'jev',
    'assessment',
    'assessor',
    'semantic',
    'typesafe',
    'openrouter',
    'systemone',
    'system one',
    'model',
    'models',
    'egress',
    'risk',
    'confidence',
    'sensor',
  ],
  pathHints: ['decision'],
});

const DEPENDENCIES = definePack({
  id: 'dependencies',
  version: '1.0.0',
  area: 'dependencies',
  title: 'Dependencies and manifests',
  summary:
    'The approved runtime dependency set, pinned adapter tooling, and conservative manifest changes.',
  rules: [
    {
      id: 'deps-approved-core',
      text: 'Core runtime dependencies are Ajv, YAML, and picomatch only; do not add unapproved packages.',
      source: 'docs/decisions.md #5',
    },
    {
      id: 'deps-no-heavy-stack',
      text: 'Do not add web frameworks, ORMs, LLM SDKs, expression engines, or a second language runtime.',
      source: 'docs/decisions.md #5',
    },
    {
      id: 'deps-pi-dev-only',
      text: 'Keep the Pi package as a pinned adapter development dependency; core code must not import Pi providers.',
      source: 'docs/decisions.md #5',
    },
    {
      id: 'deps-lockfile',
      text: 'Commit manifest and lockfile changes together and install with `npm ci`; do not hand-edit `dist/`.',
      source: 'AGENTS.md Commands',
    },
    {
      id: 'deps-review',
      text: 'Dependency and tooling changes need explicit review; keep the diff minimal and explain the security impact.',
      source: 'CONTRIBUTING.md',
    },
    {
      id: 'deps-frozen-config',
      text: 'Do not change `package.json`, `tsconfig`, or build scripts as a side effect of an unrelated change.',
      source: 'repository scope',
    },
  ],
  keywords: [
    'dependency',
    'dependencies',
    'npm',
    'package',
    'lockfile',
    'manifest',
    'manifests',
    'ajv',
    'picomatch',
    'yaml',
    'framework',
    'orm',
    'upgrade',
    'upgrades',
    'vendored',
  ],
  pathHints: [
    'package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'tsconfig.json',
    'tsconfig.build.json',
    'node_modules',
  ],
});

const WORKFLOW = definePack({
  id: 'workflow-security',
  version: '1.1.0',
  area: 'workflow',
  title: 'Workflow and security',
  summary:
    'Honest Stage A limits, human review for security-sensitive work, and controls that belong outside the agent.',
  rules: [
    {
      id: 'workflow-log-only',
      text: 'Describe security policy as Stage A log-only. The separate engineering workflow gate may block or hold work but is not a security boundary or tamper-proof audit.',
      source: 'AGENTS.md Current security boundary',
    },
    {
      id: 'workflow-no-real-enforcement',
      text: 'Do not enable security deny or confirm without the required enforcement architecture and adversarial evidence. The workflow gate is separate, not a security boundary.',
      source: 'docs/security-model.md',
    },
    {
      id: 'workflow-human-review',
      text: 'Security-sensitive changes require explicit human review; agents propose and never self-approve.',
      source: 'CONTRIBUTING.md Security and review policy',
    },
    {
      id: 'workflow-server-controls',
      text: 'Protected branches, force-push prevention, and release authority belong to the Git host; branch names are metadata, not authorization.',
      source: 'docs/decisions.md #10',
    },
    {
      id: 'workflow-shared-writable-domain',
      text: 'Policy, audit, and snapshot files share the agent writable domain; append-only and owner-only modes are not tamper-proof.',
      source: 'AGENTS.md Current security boundary',
    },
    {
      id: 'workflow-unknown-danger',
      text: 'Unknown or dangerous operations must fail toward confirmation or denial, never silent allow.',
      source: 'workflow gate constraints',
    },
  ],
  keywords: [
    'ci',
    'workflow',
    'workflows',
    'github',
    'security',
    'review',
    'reviewer',
    'commit',
    'commits',
    'branch',
    'branches',
    'release',
    'audit',
    'threat',
    'pull request',
    'contributing',
    'protected branch',
    'secret scanning',
    'go no go',
  ],
  pathHints: [
    '.github',
    'contributing.md',
    'security-model.md',
    'decisions.md',
    'go-no-go.md',
    'agents.md',
    '.pi',
    '.opencode',
    'paseo.json',
  ],
});

/** Fixed order is part of deterministic selection and rendering. */
export const GUIDANCE_PACKS: readonly GuidancePack[] = Object.freeze([
  TYPESCRIPT_BASE,
  ENGINE,
  ADAPTERS,
  SUPERVISOR,
  DECISION,
  DEPENDENCIES,
  WORKFLOW,
]);

export const GUIDANCE_PACK_BY_ID: ReadonlyMap<string, GuidancePack> = new Map(
  GUIDANCE_PACKS.map((pack) => [pack.id, pack] as const),
);

export const GUIDANCE_PACK_BY_AREA: ReadonlyMap<string, GuidancePack> = new Map(
  GUIDANCE_PACKS.map((pack) => [pack.area, pack] as const),
);
