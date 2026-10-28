# Contributing

This repository is building toward an enforceable security boundary; the current adapters are still log-only. Delivery discipline is part of the product. Keep changes small, reviewable, and backed by evidence.

## Branch convention

Create a branch from an up-to-date `master` (or `main` if the default branch is renamed):

```bash
git switch master
git pull --ff-only
git switch -c feat/gh-123-short-slug
```

Branch names are validated in CI for every pull request and must match:

```text
^(feat|fix|chore|docs|refactor|test|ci)/[a-z0-9][a-z0-9._-]*$
```

| Prefix | Use for |
| --- | --- |
| `feat/` | New behavior or capability |
| `fix/` | Bug fix |
| `docs/` | Documentation only |
| `chore/` | Maintenance, dependencies, tooling |
| `refactor/` | Behavior-preserving restructuring |
| `test/` | Test-only changes |
| `ci/` | Workflow and automation changes |

Rules:

- Use lowercase throughout. Lowercase ticket IDs in the branch (`AMOS-123` becomes `feat/amos-123-...`).
- Start the slug with a letter or digit; then use letters, digits, dots, underscores, and hyphens.
- Keep it short and descriptive, for example `fix/pi-hook-throw` or `docs/security-review-evidence`.
- Do not use a bare `main`, `master`, `dev`, or personal name as a feature branch.
- Bot branches are **not** exempt. `dependabot/...` and `renovate/...` fail this check by design. If bot-generated PRs are adopted later, add a narrowly scoped, human-reviewed exception for the specific bot actor and prefix; do not pre-emptively allow broad prefixes.

### Parallel work and worktrees

Use one worktree per task or agent instead of sharing a dirty checkout:

```bash
git fetch origin
git worktree add ../project-atmos-feat-thing -b feat/thing origin/master
cd ../project-atmos-feat-thing
npm ci
```

When finished, remove the worktree only after its branch is merged or abandoned:

```bash
git worktree remove ../project-atmos-feat-thing
```

Never switch branches under another agent that is actively working in the same directory.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<optional-scope>): <imperative summary>

<optional body>

<optional footer>
```

Examples:

```text
feat(engine): add TTL expiry for rule proposals
fix(pi): prevent logging file contents on read failures
docs(contributing): document branch protection and review rules
ci: add Node 26 typecheck and test workflow
refactor(storage): extract JSONL append helper
test(adapters): cover malformed hook payloads
```

Allowed types are `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, and `ci`. Use `!` or a `BREAKING CHANGE:` footer for incompatible changes.

Why:

- The history stays machine-readable for changelogs, release notes, and `git log` filtering.
- Reviewers can see intent and scope before opening the diff.
- Reverts are easier to identify and reason about.
- Squash-merged PR titles remain useful; keep the PR title conventional too.

Keep the summary imperative, lowercase, and free of a trailing period. Put the "why" in the body, not only in the PR description.

## Pull requests

- One logical change per PR. Do not mix a fix with drive-by refactors, formatting sweeps, or unrelated docs.
- Split changes that need different review expertise or different rollback plans.
- Keep the PR template sections complete: summary, security impact, verification evidence, rollback, agent disclosure (if applicable), and checklist.
- Link the issue or ticket, and call out anything intentionally out of scope.
- Update documentation and tests in the same PR when behavior changes.
- Prefer squash merge so the conventional PR title becomes the commit subject. Do not merge with failing or pending required checks.

## Required verification

Run the same checks as CI before requesting review:

```bash
npm ci
npm run typecheck
npm test
```

- Both `npm run typecheck` and `npm test` must pass. CI is authoritative.
- Do not claim a fixed number of passing tests in documentation, PR text, or commit messages. Test counts drift; report the command and its actual result instead.
- Paste meaningful command output or a link to the CI run in the PR's verification evidence.
- If a check cannot run locally, say why and provide CI evidence.

Required CI jobs:

- `Typecheck and test (Node 26)`
- `Branch name convention` (pull requests only)

## Security and review policy

**Server-side branch protection is the real enforcement.** Local Git hooks and agent instructions are advisory: they can be skipped with `--no-verify`, are absent in some environments, and cannot be trusted across every contributor or agent. Configure protection in GitHub, not only in the repository.

Protected-branch rules for `main` and `master` (this repository currently uses `master`; support both):

- No direct pushes; all changes land through a pull request.
- No force pushes and no branch deletion.
- Require the CI checks above to pass.
- Require at least one human approval. Require additional review or a code owner for security-sensitive changes.
- Dismiss stale approvals when new commits are pushed, and require the branch to be up to date before merging where available.
- Include administrators where possible, so the policy is not bypassed by privilege.
- Keep the history linear (squash or rebase merge) according to repository settings.

Security-sensitive changes need explicit human review. Examples: policy evaluation and precedence, deny/confirm behavior, audit-log coverage, secret or credential handling, adapter trust boundaries, CI permissions, and release automation.

Agents and automation must not:

- Self-approve, self-merge, or bypass required checks.
- Force-push any branch, especially shared or protected branches.
- Create releases, tags, or deployment credentials.
- Disable or weaken branch protection, secret scanning, or audit logging.

A human reviewer is accountable for every merge, including agent-authored work.

### Secrets and logs

- Never commit credentials, tokens, private keys, cookies, `.env` files, or customer data. Use local untracked files or a secret manager.
- Do not print raw secrets in CI output, audit logs, fixtures, snapshots, or PR descriptions. Redact before pasting evidence.
- Audit and snapshot data can still be sensitive through paths, prompts, or metadata. Review what a new log field records and document the impact.
- If a secret is exposed, stop, rotate it, remove it from the branch history, and notify a maintainer privately. Do not open a public issue containing the secret.

## Agent-authored contributions

Agent work is allowed but must be attributable and reviewable:

- Work on a dedicated `feat/...`, `fix/...`, or other compliant branch, preferably in an isolated worktree.
- Disclose the agent/tool, model/provider when known, and the session or worktree identifier in the PR.
- Provide concrete evidence: commands run, results, relevant logs with secrets redacted, and known limitations or skipped checks.
- Do not claim checks were run when they were not. Mark unverified items explicitly.
- Do not self-approve, merge, force-push, tag, or release. Leave those actions to a human maintainer.
- If an agent is uncertain about scope or security impact, stop and ask for human direction instead of expanding the change.

## Reporting problems

Use the repository issue tracker for ordinary bugs and documentation gaps. Report suspected vulnerabilities or leaked credentials privately to the maintainers; do not include exploit details or secrets in a public issue.
