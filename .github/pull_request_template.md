## Summary

<!-- What changed and why. Pull request titles and bodies are written in English. -->

## Architecture impact report

<!--
No body declaration is required: the merge-approval gate regenerates the
architecture impact report for the exact head and publishes it to the job
summary of the gate run (never a PR comment — no notification email).
-->

## Owner approvals

<!--
Required; CI rejects pull requests without this section.
Copy-paste commands for the owner, each bound to the exact head SHA
(regenerate whenever the head moves):

```
approve-architecture <full-head-sha>
```

```
approve <full-head-sha>
```

The gates read only PR comments — these body lines are never consumed as
approvals. Approval markers match per comment line, so both commands may be
posted together in one comment. `approve-architecture` is required only when
protected paths change, but always list both so the owner never has to
reconstruct them.
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
