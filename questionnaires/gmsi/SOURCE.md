# Gold-MSI general musical sophistication

This module contains only the 18 general musical sophistication items selected
by the study owner. BI_01, ST_01, and AP_01 are excluded. It uses no new runtime
dependency and does not import the external scorer into the participant survey.

## Sources and wording

English questions, response categories, and negative keys come from the
study-owner-provided `GMSI_items.csv`. All 18 English prompts are preserved
verbatim, including the blanks in the three numerical questions. Agreement
labels preserve their original spelling/capitalization; the leading 1–7 codes
are stored as numerical positions rather than repeated in the displayed labels.

Korean questions and response labels are transcribed from the three supplied
images headed "Gold-MSI-K 최종 개발 문항". The selected item numbers in CSV order
are 1, 3, 15, 24, 19, 32, 33, 14, 37, 27, 12, 23, 4, 7, 10, 17, 25, 29.
For Korean items 32, 33, and 37, the inline alternatives are displayed as the
seven response labels below the sentence, with `___` marking their position.
The complete original sentence with inline alternatives remains in `source_text`.
No question or choice is machine-translated at runtime.

Both JSON datasets use the same IDs, order, scales, negative keys, and category
positions. `lang = "eng"` loads `en.json`; `lang = "kor"` loads `ko.json`.
Selected-language failures stop startup; there is no language substitution.
The datasets identify this selection as `gold_msi_general_18_v1`.

Gold-MSI references:
- https://www.gold.ac.uk/music-mind-brain/gold-msi/
- https://shiny.gold-msi.org/gmsiscorer/

These sources are distinct from Big Five. Its upstream MIT notice is not a
license for the Gold-MSI material.

## Presentation and raw data

There are exactly two pages of nine required items, in supplied CSV order,
with no default selection and no randomization. GMSI and Big Five share the
same application styling and the existing pinned survey-likert plugin.
GMSI runs once before Big Five after listening, or after demographics when
`skipSessionsForVerification` is enabled. Participants receive no score report.

Each jsPsych page retains its original 0–6 `response` indexes. `gmsi_answers`
also records item/source wording, Korean source number, scale, negative key,
selected index, unreversed `response_1_to_7`, and selected response text.
The full JSON and main CSV retain both pages, language/version metadata,
per-item response labels, and page timing. Exporting never modifies live rows.

## Scorer-ready export

The separate `CCM_<experiment_version>_<session_id>_gmsi.csv` contains one row
with exactly `session_id` followed by the 18 canonical item IDs in CSV order.
It uses UTF-8, commas, double-quoted cells, and CRLF row separators.
Every item value is an integer code from 1 to 7, representing the selected
category position; negative items are not reversed in this file.

| Code | MT_01: years | MT_02: hours/day | MT_06: instruments |
| --- | --- | --- | --- |
| 1 | 0 | 0 | 0 |
| 2 | 1 | 0.5 | 1 |
| 3 | 2 | 1 | 2 |
| 4 | 3 | 1.5 | 3 |
| 5 | 4-5 | 2 | 4 |
| 6 | 6-9 | 3-4 | 5 |
| 7 | 10 or more | 5 or more | 6 or more |

Korean categories correspond position-for-position, including 30 minutes for
0.5 hours and 1 hour 30 minutes for 1.5 hours. Agreement items use their selected
1–7 position. MT_03, MT_07, PA_08, SA_04, and SA_05 are negatively keyed.

Scorer settings: ID variable `session_id`, Header checked, Comma separator,
Double Quote, and Reverse Negative Items checked. The EN item table matches
these IDs, categories, and negative keys. The scorer currently offers no Korean
mode; using EN for Korean-coded responses requires verification in that app.
No aggregate totals, norms, or interpretations are calculated in this module.
Only the General scale is fully collected; other subscales are incomplete.

All four study files are prepared and validated before upload. Completion
requires explicit confirmation for every file, including GMSI. Failures retain
the existing participant session-ID display and retry behavior. No automatic
submission to the external scoring app occurs.
