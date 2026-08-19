## Summary

<!-- What changed and why. Pull request titles and bodies are written in English. -->

## Change impact declaration

<!--
Required; the merge-approval gate rejects pull requests without it.
Run `node scripts/generate-change-impact-declaration.js` right before pushing
and paste the generated block below, filling every newFiles reason first,
the coordinators list for multi-module changes, and the verification note.
The declaration binds the head SHA: regenerate it whenever the head moves
(rebase, new commits), otherwise the gate rejects it as stale.
Charter 8.10 fields are all mandatory: capabilities, modules, invariants,
policyDelta, baselineWaiverDelta, newFiles, behaviors, semanticImpact,
coordinators, verification.
-->

## Owner approvals

<!--
Required; CI rejects pull requests without this section.
Copy-paste commands for the owner, each bound to the exact head SHA
(regenerate whenever the head moves, same rule as the declaration):

```
approve-architecture <full-head-sha>
```

```
approve <full-head-sha>
```

The gates read only PR comments — these body lines are never consumed as
approvals. `approve-architecture` is required only when protected paths
change, but always list both so the owner never has to reconstruct them.
-->

## Skill harvest

<!--
Required; CI rejects pull requests without this section.
Record the harvesting-workflow-lessons decision for this branch, one line:
  no skill change — <one-line evidence>
  updated .skills/<name> — <one-line evidence>
The same decision must appear as the Skill-Harvest trailer of the capability
audit commit (regenerate-capability-audit.js --harvest).
-->

## Verification

<!-- Focused checks, npm run test:ci:linux result, and any manual steps. -->
