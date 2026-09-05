# Independent Level 1/2 certification schema

`scripts/release-level-certifier.mjs` accepts only schema version 2. The tester must exclusively create the certification JSON below the protected formal run root after cleanup. Extra, missing, or renamed fields are rejected.

The top-level object contains exactly:

| Field | Required value |
| --- | --- |
| `schemaVersion` | `2` |
| `kind` | `"aimuse-independent-level-certification"` |
| `level` | `1` or `2`, matching declared inputs |
| `overall` | `"PASS"` |
| `startedAt`, `finishedAt` | UTC ISO timestamps; finish must not precede start |
| `tester` | Exact attribution object described below |
| `interfaces` | Exact interface object described below |
| `subject` | Exact caller-held digest object described below |
| `report` | Owner-private report binding |
| `cases` | Every contract case, in exact contract order |
| `findings` | Exact severity object |
| `coverageExceptions` | Empty array |
| `cleanup` | Exact all-true cleanup object |

`tester` contains exactly `role`, `taskId`, `implementationTaskId`, `model`, and `reasoningEffort`. Values are `"independent-tester"`, the tester's distinct task ID, the ID from declared inputs, `"gpt-5.6-luna"`, and `"high"`. The two task IDs must differ.

`interfaces` contains exactly:

```json
{
  "sourceInspection": "manifest-authorized-only",
  "computerUse": "native-computer-use",
  "mcp": "isolated-qa-mcp",
  "playwrightSubstitute": false
}
```

`subject` contains exactly `declaredInputsSha256`, `automationObservationsSha256`, `automatedVerificationSha256`, `packageManifestSha256`, `subjectIdentitySha256`, `executableSha256`, and `applicationAsarSha256`. Copy none of these from prose or a prior run; bind the exact caller-held files and the current independently derived automated-verification object.

`report` contains exactly `path`, `bytes`, and `sha256`. `path` is relative to the formal run root. The report and every case artifact must be a real owner-private file below that unchanged root.

`cases` has one object for every ID in `formal-release-contract.json` at `certification.<level>.requiredCaseIds`, in that exact order. Each case contains exactly `id`, `outcome`, and `evidence`; `outcome` is `"PASS"`, and `evidence` is a nonempty array of objects containing exactly `path`, `bytes`, and `sha256`. A shared artifact may support multiple cases only when its contents actually contain independently attributable observations for each named case.

`findings` contains exactly the array fields `BLOCKER`, `P0`, `P1`, `P2`, and `P3`. A full pass requires empty `BLOCKER` and `P0` arrays. `coverageExceptions` must be empty; a missing mandatory observation is `BLOCKED`, not a certifiable pass.

`cleanup` contains exactly these keys, all `true`:

```json
{
  "credentialsRedacted": true,
  "engineStopped": true,
  "noRunOwnedProcessSurvived": true,
  "packageReverifiedAfterStop": true,
  "formalRootIdentityStable": true
}
```

The tester's `overall: "PASS"` is a disposition, not the release result. The caller separately pins the verifier, witness, and final-certifier bytes. Only the exclusively published `independently-derived-full-level-verification` output may make the final Level 1/2 `PASS` claim.
