# CCM-Online-Survey
Website made with jsPsych for emotion evaluation of CCM

## Local preview

Open the experiment through HTTP/HTTPS. Opening `index.html` directly with a
`file://` address prevents loading the questionnaire data and stimulus metadata.
Direct-file opening displays local-server instructions before any module imports,
so the browser's module restriction cannot leave this case as a blank page.

For a local preview, run this from the repository directory using the existing
Python installation:

```powershell
python -m http.server 8765 --bind 127.0.0.1
```

Keep the server running and open <http://127.0.0.1:8765/> in the browser.
Data saving still uses the configured DataPipe experiment; do not complete a
synthetic survey against production storage.

## Workflow and verification toggle

Both conditions follow consent, eligibility, demographics, headphone/calibration
checks, instructions/practice, session 1, the optional session 2, musical
sophistication, Big Five, and debrief. Big Five runs once after the listening
sessions, whether the participant accepts or declines session 2.

`experimentConfig.skipSessionsForVerification` in `index.html` replaces the
old first-session-only toggle. It is currently `true`: after consent, eligibility,
and demographics, participants go directly to musical sophistication and Big
Five. Calibration, practice, both listening sessions, the second-session choice,
audio preloads, and stimulus-metadata fetching are skipped. The normal DataPipe
condition assignment still occurs. These runs have `sessions_completed: 0` and
`verification_skip_sessions: true` in the saved data.

Set the toggle to `false` to run the normal listening workflow. The marker is then
`false`, and only completed listening sessions contribute to the session count.
This developer setting is not a participant-facing option.

## Stimulus selection

In `index.html`, `experimentConfig.stimulusPoolSize` controls the number of
eligible numbered clips (currently 4831). `stimulusFirstNumber` controls the
starting filename number (initially 1). The pool is therefore
`audio/0001.mp3` through `audio/4831.mp3`. The pool must contain at least
60 clips and exclude practice/calibration audio.

In the normal workflow, startup loads `metadata.csv`, validates each configured
clip's `clip_filename` / `work_id` mapping, and samples 60 distinct clips without
replacement. The first 30 form session 1 and the remaining 30 form optional
session 2. Each session preloads only its own batch. Selection is independent
across participants. Main listening, emotion, and familiarity rows retain
`work_id`; shared rows record `stimulus_pool_size` and `stimulus_first_number`.
Missing/invalid metadata or audio stops the affected workflow.

## Questionnaires

Musical sophistication uses the 18-item General scale of Gold-MSI, excluding
BI_01, ST_01, and AP_01. It has two pages of nine required questions, in the
supplied English CSV order. English wording comes from that CSV; Korean wording
comes from the corresponding Gold-MSI-K appendix items. Both use the same
seven-choice positions and the same presentation styling as Big Five. See
[GMSI source and coding](questionnaires/gmsi/SOURCE.md).

The personality placeholder has been replaced with the full 120-item
Johnson IPIP-NEO questionnaire from
[rubynor/bigfive-web](https://github.com/rubynor/bigfive-web).

The existing `lang` setting controls both GMSI and Big Five: `"eng"` loads
English and `"kor"` loads Korean, including each questionnaire's instructions
and navigation. Missing or invalid selected-language data stops startup.
For Big Five, all question and choice wording, UUIDs, ordering,
domain/facet mappings, and reverse keys are preserved from the pinned source.
There are 12 pages of 10 required items, no default responses, and no results
screen, interpretation, or participant download. Scores are calculated silently.

The static modules live in `questionnaires/gmsi/`, `questionnaires/bigfive/`, and `exports/`;
no framework, build system, backend, or new runtime dependency is required. See
[SOURCE.md](questionnaires/bigfive/SOURCE.md) for the source commit, scoring
version, raw/derived field definitions, and [LICENSE](questionnaires/bigfive/LICENSE).
Keep these files with the application when publishing the static site.

## Data storage

`index.html` uses jsPsych 8.3.0 and pinned plugins from CDN URLs. Completed,
consented runs are sent directly to DataPipe experiment `RWxInotIIqbc` using the
existing persistence flow. The public experiment ID is not a credential.

### What is saved

After an acknowledged debrief, the application prepares five UTF-8 files from
one snapshot before sending any request:

- `CCM_<experiment_version>_<session_id>.json`: the full structured record,
  including every trial, both GMSI pages, all Big Five raw responses, scored
  items, and results.
- `CCM_<experiment_version>_<session_id>.csv`: experiment results only, with
  one row per completed music trial in actual presentation order. It contains
  30 rows after one session or 60 after two, excluding practice and questionnaires.
- `CCM_<experiment_version>_<session_id>_procedural.csv`: exactly one participant
  summary row containing consent, eligibility, completed-session/practice counts,
  instruction duration, and overall duration.
- `CCM_<experiment_version>_<session_id>_bigfive.csv`: one row containing all
  Big Five raw responses and results.
- `CCM_<experiment_version>_<session_id>_gmsi.csv`: one scorer-ready row with
  exactly `session_id` and the 18 canonical item columns. Values are unreversed
  1–7 selected-position codes, including the three numerical-category items.
  The raw 0–6 indexes, exact item/choice wording, language/version metadata,
  and timing remain in the full JSON.

The same existing random 16-character `session_id` links all five files. It is
generated once per page load, shared across listening sessions, and never
replaced with a second participant identifier. The full JSON and Big Five CSV
share one `completed_at` timestamp. The analysis CSVs omit that
timestamp and experiment version. The minimal scorer CSV keeps only the ID and
item columns. The internal experiment version remains `ccm_draft_06`.

### Experiment CSV columns

Both conditions begin with `trial_no`, `work_id`, `session_id`, in that order,
and end with `familiarity`, `response_time_seconds`. Trial numbers run continuously
from 1 to 30 or 60 across the participant's main sessions, following the recorded
presentation order rather than filenames or the original selection order.

- Condition 1: the response columns are `emotion_1` through `emotion_N`, with
  one final retained keyword per cell in entry order. N is the largest keyword
  count in any of this participant's main trials; shorter lists are padded with
  empty cells. CSV quoting preserves Korean, commas, quotes, and line breaks.
  Merging participant files later must align columns by header and accommodate
  the largest N. The emotion positions do not imply ranking or intensity.
- Condition 2: the response columns, in order, are `arousal`, `attention`,
  `certainty`, `commitment`, `dominance`, `identity`, `obstruction`, `safety`,
  `valence`. These map respectively to the existing question IDs `stimulation`,
  `focus`, `certainty`, `person_commitment`, `dominance`, `group_identity`,
  `obstruction`, `safety`, `pleasantness`. All nine scores and familiarity are 1–9;
  question wording, anchors, ordering, and raw 0–8 responses are unchanged.

Response time uses a monotonic browser clock from the audio trial's end callback
to familiarity submission, divided by 1,000. It includes emotion evaluation,
the transition, and familiarity evaluation; it excludes the five-second clip.
The timing boundaries and raw plugin response times remain in JSON. The CSV
does not contain stimulus IDs, session numbers, experiment versions, audio paths,
raw response objects, keyword event histories, or questionnaire/procedural rows.

### Procedural CSV columns

The single row has exactly `session_id`, `condition`, `sessions_completed`,
`overall_duration_minutes`, `consented`, `eligibility_1`, `eligibility_2`,
`eligibility_3`, `eligibility_4`,
`instruction_duration_minutes`, `practice_sessions_completed`, `phone_number`,
`email_address`.

Both conditions show the optional Korean contact-information page immediately
after the last Big Five page and before debrief, including verification runs
that skip listening sessions. Either field or both fields may be left blank.
The page explains that contacts are collected for the pilot coffee-gift-card
draw. A supplied email is checked by the browser's email input. Phone numbers
use three digit-only fields in `000-0000-0000` format, requiring 3, 4, and 4
digits. Completing each phone field advances focus to the next, with the last
field advancing to email. All three phone fields may be blank; once a number
is started, all three must be completed.

The procedural CSV appends the phone number and email address as strings.
The phone number contains exactly 11 digits without hyphens, preserving leading
zeros (for example, `01012345678`). The raw JSON response retains the three
segments as `phone_number_1`, `phone_number_2`, and `phone_number_3`, alongside
the combined `phone_number` value.
Unfilled fields are empty strings. Exactly one contact response row with both
string fields must exist; a missing, duplicate, or malformed row stops export
rather than inventing blank responses. The complete raw contact response also
remains in JSON. Contact columns are not added to the experiment, GMSI, or
Big Five CSVs.

The pilot uses four required Korean eligibility questions from the
[reference survey](https://blues95.github.io/jangdan_project_test/):
age 20–64, hearing difficulties, hand-movement difficulties, past/current
neurological or psychiatric conditions. The consent-signature question is omitted
for the pilot. `eligibility_1` through `eligibility_4` retain the raw `yes`/`no`
answers in that order in both JSON and procedural CSV. Like the reference page,
this screen records answers without automatic exclusion or a derived `eligible`
flag. Consent is recorded on the preceding introduction page.

Overall duration is the final debrief row's elapsed time divided by 60,000:
from jsPsych's first consent screen through debrief acknowledgment, including
instructions, practice, music sessions, questionnaires, and idle/loading time
inside that timeline. It excludes startup before the timeline and final uploads.
Instruction duration is the instructions plugin's total response time divided
by 60,000, including revisits without exporting navigation history. Practice
counts completed cycles reaching the decision screen after familiarity, not
starts or button clicks.

Verification runs that skip the listening workflow produce a header-only
experiment CSV and a procedural row with zero completed music/practice sessions,
zero instruction duration, and an empty completed-condition cell. The assigned
condition and verification marker remain in raw JSON and questionnaire metadata.

Each participant uploads their own result and procedural files. There is no
shared-file append operation; these files are intended to be merged later using
`session_id`. Missing, inconsistent, or incomplete trials/procedural records
stop preparation before any file is uploaded.

The dedicated Big Five CSV contains:

- Raw 0–4 response indexes, selected 1–5 positions, and separate reverse-keyed
  scores for each of the 120 UUIDs.
- Five domain and 30 facet scores, counts, and classifications, using the
  web app's pinned `@bigfive-org/score@1.2.2` calculation.
- Language, source/scoring versions, condition, completion/verification metadata.
- Quoted JSON cells retaining exact item/choice wording, metadata, and page
  responses/timing.

CSV projections do not remove or overwrite live jsPsych rows. The full JSON keeps
all raw records, demographics, instructions, practice responses, and both
questionnaires. Import CSV as UTF-8. Nested objects in the unchanged Big Five
CSV remain quoted JSON cells.

Only consented runs ending with an acknowledged debrief upload. Unfinished runs
and early exits do not upload. There is no ongoing autosave, browser storage,
download fallback, or reload recovery. Responses stay in memory while the tab
is open. Closing/reloading before confirmed submission can lose unsaved data.

Every questionnaire must be complete and internally consistent before upload.
Each encoded request must be smaller than 32,000,000 bytes. Preparation failure
in any file prevents all uploads.

### Confirmation, errors, and retries

Requests go to `https://pipe.jspsych.org/api/data/` with `experimentID`,
`filename`, and `data`. The order is JSON, experiment CSV, procedural CSV,
Big Five CSV, then GMSI CSV.
Each request has a 30-second timeout. Only HTTP 201 with
`message: "Success"`, no error field, and no queue indication confirms storage.
Completion requires explicit confirmation for all five files.

During preparation/transmission, the only status text is:

- Korean: 결과를 전송중입니다. 창을 닫지 말고 잠시만 기다려 주십시오
- English: Sending results. Do not close the tab

On failure, participants see a brief message and their `session_id`, with
instructions to record it and contact the researcher. No scores, filenames,
per-file status, HTTP status, or diagnostic codes appear on screen. Fixed
diagnostic code/file/HTTP fields are available on the display element's
`dataset` for researcher inspection; raw server bodies and exception messages are
never rendered or logged.

- Confirmed files remain saved and are skipped on retry. Uploads stop at the
  first failure; partial completion never counts as overall success.
- Network/time-out/transient or ambiguous confirmation failures permit a manual
  retry after five seconds. The timer only enables the button; it never uploads.
  Retries use identical filenames, bodies, IDs, and completion timestamps.
- Rejections requiring configuration/data correction stop further submission.
- Queued responses (HTTP 202 or an explicit queue indication) and duplicate
  conflicts (HTTP 409 or `OSF_FILE_EXISTS`) block competing retries and require
  researcher inspection. Neither means confirmed storage.
- Simultaneous clicks and repeated completion callbacks cannot start another
  submission. Filename collisions never authorize overwriting or renaming.

A lost confirmation can become a duplicate on retry. Use the displayed
`session_id` to inspect DataPipe logs/queue and destination files, compare their
contents, and retain the matching records. Multi-file submission is not atomic;
the browser cannot independently verify private files or guarantee exactly-once
delivery. Existing DataPipe service-managed retries remain separate.

### DataPipe configuration

The configured experiment has no session limit, per the study owner's setting.
No quota change is needed for the additional CSV.

Before collection, verify the intended receiving destination, approved
visibility, working authorization, active text-data collection, and storage.
Allow both JSON and CSV if validation is enabled. Only `session_id` is common
to every file: the minimal GMSI CSV has only that ID and its 18 item columns.
Any required-field rule applied to all files must accept that schema.
`trials` exists only in the JSON envelope and must not be required for CSV.
Verify that validation also accepts the wide, single-row Big Five CSV.

Sequential condition assignment must remain enabled for two conditions.
The survey does not use the base64 endpoint. Do not put tokens or other secrets
in browser code.

[DataPipe's current notice](https://pipe.jspsych.org/) states that it will stop
writing to OSF after November 16, 2026. The existing OSF destination and any
necessary later migration must be handled separately; this change does not
replace the persistence provider.

## Local verification

With an existing Node.js installation, run:

```powershell
node --test tests/bigfive.mjs tests/gmsi.mjs tests/study-exports.mjs
```

These dependency-free checks cover source wording fingerprints, both languages,
reverse scoring and results, normal/skip paths in both conditions, separate
CSV contents, full JSON retention, exact sending messages, delayed fifth-file
confirmation, failure at each file position, stable retries, queued/duplicate/
rejected/malformed responses, timeouts, and incomplete data. All network
boundaries are intercepted; they never submit to production DataPipe.
GMSI checks also cover exactly two pages of nine, all seven category positions,
unreversed exports, excluded items, incomplete/mismatched data, and selected
language loading failures.
Study export checks also cover 30/60 trial rows in both conditions, final keyword
padding and Unicode/CSV escaping, renamed 1–9 dimension scores, cross-screen
response timing, procedural durations/counts, verification runs, non-mutation,
and preparation failures before any of the five uploads.

The control-flow checks use a minimal jsPsych/DOM boundary and do not replace
browser verification of actual rendering or live persistence. For a browser
pilot, intercept all DataPipe requests or obtain separate approval for clearly
identified synthetic submissions. Inspect actual destination files before
claiming live storage is verified.

Official references:
[DataPipe API](https://pipe.jspsych.org/docs/api),
[jsPsych data](https://www.jspsych.org/v8/overview/data/),
[survey-likert](https://www.jspsych.org/v8/plugins/survey-likert/).
