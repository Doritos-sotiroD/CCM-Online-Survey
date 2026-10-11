# Big Five source and integration

Instrument: Johnson IPIP-NEO-120, 120 items, five domains (N/E/O/A/C),
six facets per domain. Each domain has 24 items; each facet has four.

The English/Korean item and choice wording, UUIDs, order, domain/facet mapping,
and plus/minus keys are preserved from
[rubynor/bigfive-web](https://github.com/rubynor/bigfive-web/tree/e8f3caca49edafb9bc6b927eff7fbc1264312c24),
commit `e8f3caca49edafb9bc6b927eff7fbc1264312c24`.

`data/en.json` and `data/ko.json` contain the unchanged item objects from
`old-packages/questions/data/{en,ko}/questions.json` and the choices from
`old-packages/questions/data/{en,ko}/choices.js`, wrapped with source/language
metadata. The wording and scoring metadata were also compared with the newer
`packages/questions/src/data/{en,ko}/` sources at the same commit and match.
English `ipipId` metadata are retained where provided upstream.

`scoring.js` adapts the calculation from
[`@bigfive-org/score@1.2.2/lib/reduce-factors.js`](https://unpkg.com/@bigfive-org/score@1.2.2/lib/reduce-factors.js),
the version pinned in upstream `web/package.json`. For valid complete answers,
the totals, counts, and classifications match that implementation. This choice
is deliberate: the newer TypeScript scoring directory in the same repository
uses different classification thresholds. We use the web app's pinned version.

- Raw jsPsych answers are unchanged zero-based positions (0–4).
- `response_1_to_5` is the selected display position plus one, before reversal.
- `score` comes directly from the source choice's score: 1–5 for plus items,
  5–1 for minus items. Reverse scoring is applied once.
- Domain and facet results sum these scores and retain item counts. A mean
  above 3 is `high`, below 3 is `low`, and exactly 3 is `neutral`.
- No norms, percentiles, interpretations, or additional scoring are introduced.

The adapted UI uses the application's existing pinned survey-likert plugin:
12 pages of 10 required items, fixed source order, no preselected answers.
`lang = "eng"` loads English; `lang = "kor"` loads Korean. There is no report,
results screen, upstream account/storage integration, or participant download.
Scores are saved silently with the final questionnaire page.

`export.js` verifies all 120 raw answers against their saved derived values and
recomputes the results before any upload starts. The dedicated CSV has one row
per `session_id`, raw-index/selected-position/scored-value columns for each UUID,
all five domain and 30 facet scores/counts/classifications, and JSON cells with
exact wording, response labels, item metadata, and page-level raw responses/timing.
The full JSON export also retains every Big Five page. The main response CSV
excludes only these Big Five pages, without deleting anything from live data.

Questionnaire code and data are distributed under the upstream MIT notice in
`LICENSE` (Copyright 2024 B5 Holding AS). IPIP items are also
[public domain](https://ipip.ori.org/newPermission.htm).
