# Initial Git snapshot boundary

This document originated before the first Git snapshot. Its descriptions of an uncommitted checkout and proposed first commit are historical, not current repository status or an assignment. The manifest and never-track boundaries below remain applicable. Read the live [AIMuse context](../../Secretary/shared/projects/aimuse.md) for current decisions and work.

## Never-track boundary

`.gitignore` anchors local coordination/evidence names at the repository root, including `.codex`, `.agents`, `test-results`, `connection.json`, `rename-visibility.json` and `identity-01-target.dat` through `identity-05-target.dat`. It also excludes credentials, environment/signing secrets, generated native/package outputs, caches and user projects. Those objects are not source and must never be inspected to decide whether they belong in Git.

`scripts/initial-snapshot-manifest.json` is the machine-readable allowlist. `npm run portability:check` enumerates only its named source/configuration trees and literal files; it never enumerates the repository root. It rejects case/Unicode collisions, Windows-reserved or otherwise non-portable paths, symlinks, overly long paths, case-mismatched relative imports, a missing ignore/attribute contract or a broken Node 24 lock.

## Proposed first snapshot

After a human reviews ownership, author identity and publication intent, run the portability check and stage only this literal allowlist—never `git add .`, `git add -A`, a root wildcard or a root-recursive discovery command:

```text
git add -- .gitattributes .gitignore .nvmrc CHANGELOG.md LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md eslint.config.mjs forge.config.ts index.html package-lock.json package.json playwright.config.ts playwright.renderer.config.ts tsconfig.json vite.main.config.ts vite.preload.config.ts vite.renderer.config.ts vitest.config.ts vitest.macos.config.ts vitest.performance.config.ts .github/workflows docs e2e native/CMakeLists.txt native/dependency-lock.json native/cmake native/src native/tests packages/core/package.json packages/core/src scripts src tests
```

Before the first commit, inspect the staged name list and staged patch, confirm that every path is within the allowlist, and confirm no credential/evidence name is present. Choosing the Git author, repository owner, remote, visibility, license publication posture and initial commit message remains a user decision. Do not add a remote or publish as a side effect of this checklist.

`.gitattributes` applies portable line-ending and binary rules only when paths are first added. Do not run a bulk renormalization against this uncommitted working tree.
