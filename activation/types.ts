import type { AdvisorySnapshot, InjectionRoute } from '../injector/snapshot.ts';

/** P1 is an offline content compiler, not an authenticated publisher or gate. */
export const ACTIVATION_FORMAT = 'amos-project-activation' as const;
export const ACTIVATION_FORMAT_VERSION = 1 as const;
export const ACTIVATION_COMPILER_VERSION = 'amos-project-activation-v1' as const;

export interface RuleRef {
  readonly id: string;
  readonly version: number;
}

/** Only selection metadata; narrative, provenance, lifetime and pairing are derived. */
export interface InjectionMetadata {
  readonly areas: readonly string[];
  readonly pathHints: readonly string[];
  readonly taskTags: readonly string[];
  readonly keywords: readonly string[];
  readonly tags: readonly string[];
  readonly specificity: number;
  readonly priority: number;
}

export interface VersionedRule {
  readonly version: number;
  /** An unchanged constraints/schema.json record, not an extended rule schema. */
  readonly rule: Readonly<Record<string, unknown>>;
  readonly injection: InjectionMetadata | null;
}

export interface ActivationCompilerOptions {
  readonly rawSchema: string;
  readonly libraryVersion: string;
  readonly rules: readonly VersionedRule[];
  /** Fixed by the compiler's caller, never taken from the project selection. */
  readonly mandatoryRuleRefs: readonly RuleRef[];
}

export interface ProjectActivationInput {
  readonly projectId: string;
  readonly workspace: string;
  readonly policyVersion: string;
  readonly selectedRuleRefs: readonly RuleRef[];
  /** Subtracted from selection; excluding a mandatory member is an error. */
  readonly excludedRuleIds: readonly string[];
  readonly advisoryBaselineRuleIds: readonly string[];
  readonly routes: readonly InjectionRoute[];
}

export interface ActiveRule extends VersionedRule {
  readonly id: string;
  readonly mandatory: boolean;
}

export interface ExecutionProjection {
  readonly status: 'ready' | 'empty';
  readonly activationDigest: string;
  readonly digest: string;
  readonly rules: readonly Readonly<Record<string, unknown>>[];
}

export type AdvisoryProjection = {
  readonly activationDigest: string;
  readonly digest: string;
} & (
  | { readonly status: 'ready'; readonly snapshot: AdvisorySnapshot }
  | { readonly status: 'empty'; readonly snapshot: null }
);

export interface ProjectActivationSnapshot {
  readonly format: typeof ACTIVATION_FORMAT;
  readonly formatVersion: typeof ACTIVATION_FORMAT_VERSION;
  readonly compilerVersion: typeof ACTIVATION_COMPILER_VERSION;
  readonly mode: 'offline-shadow';
  readonly libraryVersion: string;
  readonly schemaDigest: string;
  readonly project: ProjectActivationInput;
  readonly activeRules: readonly ActiveRule[];
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
