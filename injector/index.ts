/**
 * Public advisory injector surface. Adapters should prefer this module over
 * the transitional guidance pack API.
 */

export {
  compileAdvisorySnapshot,
} from './snapshot.ts';
export type {
  AdvisoryRule,
  AdvisorySnapshot,
  CompileAdvisorySnapshotOptions,
  InjectionChannel,
  InjectionInput,
  InjectionRoute,
  InjectionRouteMatch,
} from './snapshot.ts';

export {
  createProjectSeedSnapshot,
  DEFAULT_SEED_BASELINE_RULE_IDS,
  getProjectSeedSnapshot,
  guidancePacksForRuleIds,
} from './seed.ts';

export {
  selectAdvisoryRules,
  matchesPathHint,
} from './select.ts';
export type {
  AdvisoryRuleCandidate,
  InjectionSelection,
} from './select.ts';

export {
  renderAdvisoryBlock,
  DEFAULT_MAX_CHARACTERS,
  DEFAULT_MAX_RULES_PER_BLOCK,
} from './render.ts';
export type {
  RenderAdvisoryBlockInput,
  RenderedAdvisoryBlock,
} from './render.ts';

export {
  createInjectorSession,
  AREA_CHARACTERS,
  MAX_RULES_PER_BLOCK,
  PROMPT_CHARACTERS,
  PROMPT_FALLBACK_CHARACTERS,
  SESSION_TOTAL_CHARACTERS,
} from './session.ts';
export type {
  InjectionBlock,
  InjectorSession,
  StructuralAction,
} from './session.ts';
