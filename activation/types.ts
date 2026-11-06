import type { AdvisorySnapshot, InjectionRoute } from '../injector/snapshot.ts';

/** P1 is an offline content compiler, not an authenticated publisher or gate. */
export const ACTIVATION_FORMAT = 'amos-unified-rule-catalog' as const;
export const ACTIVATION_FORMAT_VERSION = 2 as const;
export const ACTIVATION_COMPILER_VERSION = 'amos-unified-rule-catalog-v2' as const;

export interface RuleRef {
  readonly id: string;
  readonly version: number;
}

/** Only selection metadata; narrative, provenance, lifetime and pairing are derived. */
export interface InjectionMetadata {
  /** P1 advisory ordering only; lower values are selected first. */
  readonly level: number;
  readonly areas: readonly string[];
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly pathHints: readonly string[];
  readonly taskTags: readonly string[];
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  readonly specificity: number;
  readonly priority: number;
}

export type RuleProvenance =
  | {
      readonly kind: 'legacy-constraints-yaml';
      readonly sourceDigest: string;
    }
  | {
      readonly kind: 'guidance-pack-seed';
      readonly sourceDigest: string;
      readonly packId: string;
      readonly packVersion: string;
      readonly sourceRef: string;
    };

/** One immutable record in the unified catalog. Pure guidance has no fake legacy rule. */
export interface VersionedRule {
  readonly id: string;
  readonly version: number;
  /** An unchanged strict constraints/schema.json record, or null for pure guidance. */
  readonly rule: Readonly<Record<string, unknown>> | null;
  /** Used only when `rule` is null; executable narrative is always derived from the rule. */
  readonly narrative: string | null;
  readonly provenance: RuleProvenance;
  readonly injection: InjectionMetadata | null;
}

export interface ActivationCompilerOptions {
  readonly rawSchema: string;
  readonly catalogVersion: string;
  readonly rules: readonly VersionedRule[];
  /** Fixed by the compiler's caller, never taken from the project selection. */
  readonly mandatoryRuleRefs: readonly RuleRef[];
}

export interface ProjectActivationInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly selectedRuleRefs: readonly RuleRef[];
  /** Subtracted from selection; excluding a mandatory member is an error. */
  readonly excludedRuleIds: readonly string[];
  readonly advisoryBaselineRuleIds: readonly string[];
  readonly routes: readonly InjectionRoute[];
}

export interface ActiveRule extends VersionedRule {
  readonly mandatory: boolean;
}

export interface ExecutionProjection {
  readonly projectId: string;
  readonly workspace: string;
  readonly catalogVersion: string;
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly checkpoint: 'runtime' | 'ci' | 'server';
  readonly status: 'ready' | 'empty';
  readonly activationDigest: string;
  readonly digest: string;
  readonly ruleRefs: readonly RuleRef[];
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

export type AdvisoryProjection = {
  readonly projectId: string;
  readonly workspace: string;
  readonly catalogVersion: string;
  readonly projectConfigVersion: string;
  readonly baseVersion: string;
  readonly epoch: number;
  readonly activationDigest: string;
  readonly digest: string;
  readonly ruleRefs: readonly RuleRef[];
} & (
  | { readonly status: 'ready'; readonly snapshot: AdvisorySnapshot }
  | { readonly status: 'empty'; readonly snapshot: null }
);

export interface ProjectActivationSnapshot {
  readonly format: typeof ACTIVATION_FORMAT;
  readonly formatVersion: typeof ACTIVATION_FORMAT_VERSION;
  readonly compilerVersion: typeof ACTIVATION_COMPILER_VERSION;
  readonly mode: 'offline-shadow';
  readonly catalogVersion: string;
  readonly schemaDigest: string;
  readonly project: ProjectActivationInput;
  readonly activeRules: readonly ActiveRule[];
  readonly epoch: number;
  readonly activationDigest: string;
  readonly enforcement: {
    readonly runtime: ExecutionProjection;
    readonly ci: ExecutionProjection;
    readonly server: ExecutionProjection;
  };
  readonly advisory: AdvisoryProjection;
  readonly digest: string;
}

export interface ProjectIdentity {
  readonly projectId: string;
  readonly workspace: string;
}

export interface ActivationStoreOptions {
  /** Injected trusted clock. The offline store never reads wall-clock time itself. */
  readonly now: () => number;
  /** Current validity/revocation check supplied by the future host/publisher. */
  readonly isCurrentAuthorization: (snapshot: ProjectActivationSnapshot) => boolean;
}

export interface ProjectActivationCompiler {
  compile(input: unknown): ProjectActivationSnapshot;
  /** Recompiles against this fixed catalog; this is consistency, not authentication. */
  verify(snapshot: unknown, expected: ProjectIdentity): ProjectActivationSnapshot;
}

export class ActivationError extends Error {
  readonly code = 'activation_error';

  constructor() {
    // Never expose schema/parser messages, source text, paths or hostile values.
    super('activation_error');
    this.name = 'ActivationError';
  }
}
