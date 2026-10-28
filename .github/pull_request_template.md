## Summary

<!-- What changed, why, and what is explicitly out of scope. One logical change per PR. -->

## Security impact

<!-- Could this change affect policy verdicts, audit coverage, secret handling, trust boundaries, or release integrity? If no, say so. -->

## Verification evidence

<!-- Commands run and their results. Paste relevant output; do not only claim a test count. -->

## Rollback

<!-- How to revert or disable this safely. Note data/snapshot/log compatibility concerns. -->

## Agent disclosure

<!-- If agent-authored: name the agent/tool, model/provider if known, and session or worktree identifier. -->

## Checklist

- [ ] The change is one logical unit and does not mix unrelated formatting, docs, or refactors.
- [ ] The branch follows the convention: `(feat|fix|chore|docs|refactor|test|ci)/<lowercase-slug>`.
- [ ] `npm run typecheck` and `npm test` pass locally or in CI; no fixed test count is claimed.
- [ ] A secret scan (or reviewed diff plus GitHub secret scanning) found no credentials, tokens, private keys, or `.env` content.
- [ ] Snapshot and log/audit impact is described, including migration or compatibility effects.
- [ ] No raw secrets or sensitive file contents appear in committed fixtures, logs, snapshots, PR text, or CI output.
- [ ] Security-sensitive changes are flagged above and require human review; no agent self-approval, self-merge, force-push, or release.
- [ ] Documentation and examples match the actual behavior, including failure modes and limits.
