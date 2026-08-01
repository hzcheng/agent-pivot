---
name: harvesting-workflow-lessons
description: Use before publishing or merging a PR in this repository to review task execution friction, user corrections, CI failures, retries, and tool or workflow ambiguity; decide whether to improve an existing Agent skill, create a reusable skill, or record that no skill change is justified; validate and include approved skill iterations before the final capability audit and push.
---

# Harvesting Workflow Lessons

## Overview

Convert evidence from the current task into concise, reusable Agent guidance
before the branch is finalized. Update skills only when the evidence exposes a
missing or ambiguous workflow rule; do not force skill churn into every PR.

All repository Agent skills live under `.skills/`; that directory is the only
canonical, editable location. `.codex/`, `.claude/`, and `.kimi/` are untracked
local mirrors.

## Workflow

Run this once after implementation and fresh verification, but before the final
main-capability audit and push. If a PR already exists, run it before the next
push and merge.

1. Collect task-local evidence:
   - user corrections that changed the process;
   - failed checks and their proven root causes;
   - false starts, avoidable retries, ambiguous authority, or unsafe assumptions;
   - repeated commands or recovery steps that required rediscovery.
2. Reduce each item to `symptom → root cause → reusable prevention`. Keep
   feature behavior and product design out unless they expose a general Agent
   workflow.
3. Read the complete existing skills whose descriptions overlap the lesson.
   Distinguish an instruction gap from a compliance gap:
   - if the skill already states the correct action clearly, report that the
     Agent failed to follow it and do not duplicate the rule;
   - if the rule is missing, ambiguous, or lacks a verification guard, improve
     the narrowest existing skill;
   - create a new skill only when the workflow is reusable across multiple
     future tasks and no existing skill owns it.
4. Prefer one concise rule plus an executable verification over incident
   narrative. Add a script only when a deterministic sequence would otherwise
   be rewritten repeatedly.
5. Use `skill-creator` for every skill creation or substantial update. Add or
   tighten repository contract tests for critical guidance, run
   `quick_validate.py` for each changed skill, and run the focused owner tests.
6. Treat `.skills/` and skill-owner tests as implementation paths. Commit
   all skill iterations first, then assign the resulting full commit SHA to the
   matching main capability, advance `audit.head`, and create a separate
   documentation-only audit commit.
7. Add a short PR summary of the evidence, decision, changed skills, and
   validation. If no update is justified, say so without modifying files.

## Decision Standard

Update a skill only when all are true:

- the lesson is supported by concrete evidence from the current task;
- the prevention applies beyond the exact branch, PR number, machine, or
  incident;
- another Agent could follow and verify the new instruction;
- the rule is not already stated clearly in an applicable skill.

Create a new skill only when the trigger is distinct and discoverable. Otherwise
update the existing owner. Examples of justified lessons include commit-level
audit sequencing, build-producer/consumer ordering, ambiguous multi-remote
GitHub commands, and verified recovery from uncertain remote writes.

## Guardrails

- Edit skills only under `.skills/`. Never modify, create, or delete skill
  files inside `.codex/`, `.claude/`, or `.kimi/`, and never treat mirror
  content as evidence of the canonical skill text.
- Do not capture secrets, tokens, private payloads, or user data in skills.
- Generalize transient paths, process IDs, run IDs, PR numbers, and commit
  hashes into stable checks and placeholders.
- Do not weaken tests, bypass required checks, or label a real regression as a
  workflow lesson.
- Do not broaden the PR with unrelated product changes.
- Perform only one harvest pass per PR update cycle. Changes to this skill do
  not recursively trigger another harvest in the same cycle.
- Preserve a clean “no skill change” outcome when the evidence is one-off,
  already covered, or too speculative.
