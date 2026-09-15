# AGENTS.md

## Purpose

This repository contains a browser-based jsPsych application for collecting responses to music and related stimuli. The current study is an online survey/experiment, but the codebase may evolve into later studies or broader experimental tooling.

Work conservatively. Preserve research validity, participant-data integrity, and the existing lightweight architecture. Prefer small, reviewable changes over broad rewrites.

## Current architecture

- `index.html` contains the main application, experiment configuration, jsPsych timeline, response logic, and data-saving flow.
- jsPsych and active plugins are currently loaded from pinned CDN URLs in `index.html`.
- `jspsych/` contains checked-in jsPsych files, but these are not the current runtime source unless `index.html` is explicitly changed to use them.
- `audio/` contains experiment audio and a small Python utility for producing clips.
- `img/` contains static image assets.
- The repository currently has no Node build system, package manifest, automated test suite, or CI workflow.

Treat this section as a description of the current implementation, not a permanent architectural requirement.

## Engineering principles

- Improve the existing design incrementally.
- Do not introduce a framework, build system, backend, database, deployment platform, or major dependency merely because it is conventional.
- If a substantial architectural change would materially solve a real problem, propose it separately with rationale, migration cost, risks, and expected benefit. Do not implement it without approval.
- Keep changes scoped to the task. Avoid unrelated cleanup, renaming, formatting churn, or speculative abstraction.
- Prefer readable, explicit code over cleverness.
- Preserve stable identifiers and data fields unless a requested change requires otherwise.

## Fail fast; no fallback code

No fallback implementations. Fail fast when required functionality is unavailable, misconfigured, or broken.

- Do not silently substitute alternate storage, mock behavior, local-only behavior, default values, compatibility paths, degraded behavior, approximate implementations, or placeholder behavior merely to keep execution going.
- Do not catch errors only to suppress them or convert them into apparent success.
- Do not invent missing configuration.
- Validate required configuration and assumptions as early as practical and raise explicit errors when they are invalid.
- Retrying the same intended operation is acceptable when appropriate. Replacing the intended operation with a different mechanism is not.
- User-visible error states should make failure clear rather than imply successful completion.

If existing code contains a fallback path, do not extend or imitate it. Flag it when relevant and change it only when the task includes that behavior.

## Research and experiment integrity

Do not change study semantics under the guise of refactoring.

The following are research-design decisions and must be changed only when the user explicitly requests the change:

- condition assignment or grouping;
- trial sequence or within-trial sequence;
- randomization or counterbalancing;
- stimulus identity, duration, ordering rules, or inclusion/exclusion;
- practice versus main-session behavior;
- response constructs, wording, scale structure, anchors, or scoring;
- construct IDs, task labels, stimulus IDs, session IDs, and experiment-version semantics;
- consent, eligibility, withdrawal, exclusion, or debrief behavior;
- participant questionnaires and demographic fields;
- persisted data shape, field names, transformations, or omission rules.

When changing participant-facing wording, preserve the intended construct. Do not invent consent, ethics, eligibility, clinical, or protocol language to fill placeholders unless specifically asked to draft it.

Preserve raw responses whenever derived values are added. Derived scores should be additional fields, not destructive replacements, unless explicitly requested.

## Participant data, privacy, and secrets

- Never commit participant response data, exports, identifiers, credentials, tokens, API keys, private endpoints containing secrets, or other sensitive material.
- Assume all client-side HTML and JavaScript is publicly inspectable. Never place a secret in browser code.
- Do not log sensitive participant information unnecessarily.
- Do not silently discard collected responses.
- Do not report a submission as successful unless the intended persistence mechanism has explicitly confirmed success.
- Keep test/pilot data clearly distinguishable from real study data when the repository later introduces such workflows.

The persistence provider is an implementation detail. Follow the repository's current persistence architecture. Replacing or adding a provider requires an explicit architectural proposal and approval.

## Dependencies and vendored code

- Use the dependency source that the active application actually loads.
- Do not edit files under `jspsych/` unless the task specifically requires modifying vendored jsPsych code or changing the application to use those files.
- Do not upgrade jsPsych or its plugins incidentally. Version changes can affect timing, data output, plugin behavior, and study reproducibility.
- Ask before installing or adding a new dependency.
- If a new dependency is approved, keep it minimal and document why it is needed.

## Working autonomy

You may, without asking first:

- inspect repository files and history;
- make task-scoped edits to existing source files;
- add or update tests/checks when they directly support the requested change;
- run non-destructive local validation commands;
- improve comments or documentation when necessary to explain the requested change.

Ask before:

- adding or upgrading dependencies;
- introducing a framework, build step, backend, database, or new persistence provider;
- deleting, moving, or substantially reorganizing files;
- making a broad refactor;
- changing research semantics listed above unless the user already requested that exact change;
- changing consent/privacy/data-retention behavior;
- changing deployment or hosting architecture;
- committing generated participant data or large generated assets;
- pushing, deploying, publishing, or otherwise making a release available to participants.

Never commit secrets or real participant-response data.

## Verification

Do not invent commands that do not exist in the repository.

Because there is currently no automated test/build system, verification should match the change:

- inspect the edited HTML/JavaScript for syntax and control-flow errors;
- check that referenced local assets exist and paths remain valid;
- verify that jsPsych plugin names and versions used by the code match the scripts actually loaded by `index.html`;
- exercise affected experiment paths in a browser when browser execution is available;
- for condition-specific work, verify both the changed condition and that the other condition was not unintentionally altered;
- for data changes, inspect the resulting jsPsych rows/payload shape and confirm raw data are preserved as intended;
- for persistence changes, test explicit success and explicit failure paths; never accept an unconfirmed save as success;
- for `audio/audio_5s_clipper.py`, run only when its Python/audio dependencies are available and the task concerns that utility.

If reliable verification cannot be performed, say exactly what was not verified and why.

## Completion standard

Before considering a task complete:

1. Confirm the change directly addresses the request.
2. Check for unintended changes to study semantics or persisted data.
3. Check failure behavior; required functionality must fail clearly rather than degrade silently.
4. Run the available relevant verification.
5. Report material limitations, unresolved placeholders, or unverified behavior.

Do not claim that a study is production-ready, ethics-ready, or collection-ready solely because the code runs.

## Future organization

Keep this root file focused on rules that apply broadly across the repository. Do not grow it into a full project manual.

If genuinely distinct subsystems emerge later, place detailed documentation in `docs/` and use nested `AGENTS.md` files only where a subtree needs materially different instructions. More specific instructions should supplement, not duplicate, this root file.
