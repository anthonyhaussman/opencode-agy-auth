# Promoting to a stable release

The repo runs on an alpha prerelease track by default (`.release-please-config.json` `prerelease: true`). Every release-please output is an `X.Y.Z-alpha.N` package on the npm `alpha` dist-tag and a git tag `X.Y.Z-alpha.N` (no `v` prefix).

To cut a stable `X.Y.Z` release from the current alpha coordinate:

## 1. Pause alpha

Edit `.release-please-config.json` at the repo root. In the `packages."."` object change:

```json
"prerelease": true
```

to:

```json
"prerelease": false
```

Commit the one-line change:

```bash
git add .release-please-config.json
git commit -m "chore(release): promote to stable track"
```

## 2. Drop any open alpha release PR

If release-please has an open PR titled `chore(main): release X.Y.Z-alpha.N`, close it via the GitHub PR UI. The next release-please run regenerates the release PR as a stable one.

## 3. Nudge release-please

Push the promotion commit to `main`. release-please re-reads the config, sees `prerelease: false`, and opens a new PR titled `chore(main): release X.Y.Z` (no `-alpha.N`). The changelog covers everything since the last stable tag (or, on the first promotion, since the `.release-please-manifest.json` anchor).

```bash
git push origin main
```

If there are no new Conventional Commits since the last alpha tag, release-please will NOT open a stable PR. In that case, push a no-op Conventional Commit (e.g. `docs: note stable promotion`) to give release-please something to release, OR force a specific version by adding `"release-as": "X.Y.Z"` to `.release-please-config.json` temporarily.

## 4. Merge the stable release PR

Review the PR's changelog. CI (build + typecheck + smoke) must pass. Squash-merge via the GitHub UI. On the push, the `release-please.yml` workflow:

1. release-please creates git tag `X.Y.Z` and the GitHub Release (auto notes from PRs since the previous tag).
2. The `publish` job runs `npm publish` (no `--tag alpha`), so the version becomes `latest` on npm. Previous alpha versions stay available under the npm `alpha` dist-tag.

## 5. Resume alpha

After the stable tag is published, flip the config back and bump the manifest anchor to the new stable version:

```json
// .release-please-config.json
"prerelease": true

// .release-please-manifest.json
{ ".": "X.Y.Z" }
```

Commit:

```bash
git add .release-please-config.json .release-please-manifest.json
git commit -m "chore(release): resume alpha track from X.Y.Z"
git push origin main
```

Next `feat:` or `fix:` on `main` opens a release PR for `X.Y.Z+1-alpha.1` (or `X.(Y+1).0-alpha.1` if a `feat:` lands).

## Guard rails

- Keep alpha cycles short (hours to a few days). Long alpha accumulates changelog noise.
- Do not cherry-pick individual alphas to stable. The stable release is the alpha HEAD plus the promotion. For a partial stable, cut a hotfix branch instead.
- `BREAKING CHANGE:` during alpha is fine - release-please bumps the major coordinate even in alpha (`1.2.0-alpha.N` -> `2.0.0-alpha.N+1`).
- To roll back a bad stable: delete the tag (`git push origin :refs/tags/X.Y.Z`), `npm unpublish` within 72h OR `npm deprecate` after, and reset `main` to the prior commit, then re-edit the manifest back to the prior version.

## Pinning a specific version via `release-as`

release-please computes the next version from Conventional Commits since the last tag (`feat:` -> minor, `fix:` -> patch, `BREAKING CHANGE:` -> major). Occasionally the computed version disagrees with an external version requirement (e.g. a `feat:` merged on a cycle that must ship as a patch-level bump for semver-promise reasons). The `release-as` config key is a one-shot override that pins the next release to a specific version regardless of commit types.

### Pin procedure

1. Edit `.release-please-config.json`. Inside `packages."."` add `"release-as": "X.Y.Z"` as the last key (mind the trailing comma on the previous line).
2. Commit: `chore(release): pin next release to X.Y.Z via release-as`.
3. Open a PR, merge. On the next push to `main` release-please updates its open release PR in place; its title flips from the computed version to `chore(main): release X.Y.Z-alpha.N`.
4. Review the release PR's changelog, squash-merge it. release-please cuts tag `X.Y.Z-alpha.N`, creates the GitHub Release, and the `publish` job pushes `@anthonyhaussman/opencode-agy-auth@X.Y.Z-alpha.N` to the npm `alpha` dist-tag.

### Unpin procedure (critical - do not skip)

`release-as` pins EVERY subsequent release until it is removed. After the pinned tag exists, you MUST remove the override or every future release stays at `X.Y.Z`.

1. Verify the tag exists: `git fetch --tags origin && git tag --list 'X.Y.Z*'` must print `X.Y.Z-alpha.N`.
2. Edit `.release-please-config.json`. Remove the `"release-as": "X.Y.Z"` line (fix the trailing comma situation on the previous key).
3. Commit: `chore(release): remove release-as override after X.Y.Z release`.
4. Open a PR, merge. release-please resumes commit-driven bumps from the anchor written in `.release-please-manifest.json` by the pinned release.

### Warning

Never leave `release-as` in `.release-please-config.json` across release cycles. Add a calendar reminder or TODO in the pin PR body to track the cleanup commit. Premature unpin (before the tag exists) reverts the next PR to the originally-computed version; always verify the tag first.
