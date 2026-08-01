# Notification delivery manual verification record

Record version: 1

Owner: Agent Pivot maintainers

Record policy: copy this document for an execution, fill every environment field, replace `NOT RUN` and the evidence placeholder, and retain the completed record with the release or pull-request evidence. A behavior passes only when every expected result is observed.

## NOTIFY-DELIVERY-001 — first-run consent and end-to-end ntfy delivery

- Prerequisites: install the candidate main and UI Bridge VSIX files in one VS Code installation; a phone with the ntfy app; outbound HTTPS access to `https://ntfy.sh` from the extension host (directly or through a proxy).
- Steps:
  1. Generate a random topic with `openssl rand -hex 16` (a 32-character string).
  2. Run `Agent Pivot: Set Notification Webhook`, pick channel `ntfy`, enter sink id `s1`, accept the default base URL `https://ntfy.sh`, paste the generated topic into `topic`, and leave `token` empty. When the command offers to enable notifications, accept; confirm the command wrote the sink skeleton into `agentPivot.notify.sinks` and set `agentPivot.notify.enabled` to `true` without any hand-edited JSON.
  3. On the first enable, the informed-consent modal appears. Decline it once and confirm `agentPivot.notify.enabled` is automatically set back to `false` in settings. Enable it again and choose `Enable notifications`; confirm the modal does not reappear on later configuration refreshes or window reloads.
  4. Install the ntfy app on the phone and subscribe to the generated topic.
  5. Run `Agent Pivot: Send Test Notification` and watch the Output Channel opened by `Agent Pivot: Show Notification Log`.
  6. Start a real Claude session from Agent Pivot, let it run for more than one minute, then let it stop (completed or waiting for input).
- Expected results: the consent modal is shown exactly once before the first activation and declining reverts the setting without looping the dialog; the test notification logs `status=200` and arrives on the phone; the real-session notification arrives on the phone and contains the project folder name, the session name, the provider, the stop reason with run duration, the hostname, and a `#` short code; it does not contain code, conversation content, or a full path.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`; phone OS/ntfy app version = `UNRECORDED`; proxy in use = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link redacted screenshots of the consent modal, the Output Channel log, and the phone notification).

## NOTIFY-DELIVERY-002 — disabled master switch sends nothing

- Prerequisites: scenario NOTIFY-DELIVERY-001 completed with the ntfy sink still configured.
- Steps: set `"agentPivot.notify.enabled": false`; start a real Claude session; let it run for more than one minute; let it stop.
- Expected results: no notification arrives on the phone; the notification log records no delivery for the event.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link the Output Channel log and a redacted screenshot of the quiet phone).

## NOTIFY-DELIVERY-003 — short sessions are filtered

- Prerequisites: notifications enabled per NOTIFY-DELIVERY-001 with `agentPivot.notify.minRunDurationMs` at its default of `60000`.
- Steps: start a real Claude session; let it stop in under 60 seconds (for example, ask a trivial question and let it finish immediately).
- Expected results: no notification arrives on the phone; the notification log shows the event was skipped as too short.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link the Output Channel log).

## NOTIFY-DELIVERY-004 — dismissing the red dot cancels the push

- Prerequisites: notifications enabled per NOTIFY-DELIVERY-001; the Dashboard shows an attention red dot for a session that just stopped.
- Steps: start a real Claude session that runs longer than one minute; when it stops and the red dot appears, dismiss the red dot in the Dashboard within the debounce window (`agentPivot.notify.debounceMs`, default 5 seconds); wait at least one more minute.
- Expected results: no notification arrives on the phone for that event; the same event is not pushed later.
- Environment: OS/version = `UNRECORDED`; VS Code/version = `UNRECORDED`; extension versions = `UNRECORDED`.
- Execution date/result: `NOT RUN` (replace with ISO date and `PASS` or `FAIL`).
- Evidence location: `UNRECORDED` (link the Output Channel log and a redacted screen recording of the dismissal).
