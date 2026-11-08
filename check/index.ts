/**
 * P7 checkpoint module: deterministic bounded tree digest, versioned
 * CheckBinding/FindingBatch contracts, and one real fixed TypeScript runner.
 *
 * This module is a local structural contract, not a remote CI gate and not a
 * security boundary. There is no server-side enforcement in this repository.
 */

export {
  CheckError,
  checkErrorCode,
  type CheckErrorCode,
} from './errors.ts';

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  SKIPPED_DIRECTORIES,
  TREE_DIGEST_DOMAIN,
  computeWorkspaceTreeDigest,
  digestTree,
  type TreeDigestOptions,
  type TreeDigestResult,
} from './tree.ts';

export {
  CHECK_BINDING_DIGEST_DOMAIN,
  CHECK_BINDING_FORMAT,
  CHECK_BINDING_VERSION,
  FINDING_BATCH_DIGEST_DOMAIN,
  FINDING_BATCH_FORMAT,
  FINDING_BATCH_VERSION,
  MAX_FINDINGS,
  acceptFindingBatch,
  createCheckBinding,
  createFindingBatch,
  isSafeRelativePath,
  type AcceptanceInput,
  type AcceptanceResult,
  type CheckBinding,
  type Checkpoint,
  type Finding,
  type FindingBatch,
  type FindingBatchStatus,
  type FindingCoverage,
  type RuleRef,
} from './binding.ts';

export {
  TYPESCRIPT_CHECK_MAX_OUTPUT_BYTES,
  TYPESCRIPT_CHECK_TIMEOUT_MS,
  TYPESCRIPT_OUTPUT_DIGEST_DOMAIN,
  runTypeScriptCheck,
  type TypeScriptCheckOptions,
  type TypeScriptCheckResult,
} from './typescript-runner.ts';
