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
Copy-paste command for the owner, bound to the exact head SHA (regenerate
whenever the head moves):

```
approve <full-head-sha>
```

The gate reads only PR comments — this body line is never consumed as an
approval. Approval markers match per comment line, so the command may share
a comment with other text.
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
