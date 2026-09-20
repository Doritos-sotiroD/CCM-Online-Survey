# CCM-Online-Survey
Website made with jsPsych for emotion evaluation of CCM

## Data storage

`index.html` runs jsPsych 8.3.0 from pinned CDN URLs. Completed, consented
sessions are sent directly to DataPipe experiment `FwC3YmrlfInI`, which forwards
them to its configured OSF Component. No additional plugin or backend is used.
The experiment ID is public; never put OSF tokens or other credentials in this
repository or in browser code.

### Before collecting data

- Inspect the experiment in the DataPipe dashboard. Verify the exact OSF Project
  and receiving Component, its approved visibility, working OSF authorization,
  active text-data collection, remaining session allowance, and storage capacity.
  Supplying an experiment ID does not verify any of these settings.
- If validation is enabled, allow JSON. The uploaded file is an object whose
  top-level fields are `session_id`, `experiment_version`, `condition`,
  `completed_at`, and `trials`. Required-field rules must match this envelope,
  not condition-specific fields inside individual trial rows. Check optional
  metadata-generation settings for compatibility before a pilot.
- This survey does not call DataPipe's condition-assignment or base64 endpoints.
  Its existing condition assignment and trial sequence remain in the survey.
- Approve the destination and filenames for synthetic pilot uploads first.
  Verify one complete session from each condition by inspecting the actual OSF
  files, not just the completion screen. Use a separate test experiment or
  clearly identified `TEST_` filenames in an isolated test harness; the production
  survey has no test-mode URL switch.
- OSF states that new Projects/Components cannot be created from November 16,
  2026 and existing Projects become read-only on February 19, 2027. Confirm that
  the collection schedule fits this service limitation. Do not assume DataPipe
  can continue uploading to OSF Projects after that date.

### What is saved and when

After the participant acknowledges the debrief, `finishSurveyAndSave()` creates
one UTF-8 JSON snapshot. The filename is
`CCM_<experiment_version>_<session_id>.json`. The existing random 16-character
session ID is generated once per page load and remains attached to every trial.
Filename collisions are errors, never permission to overwrite a file.

The file retains the existing envelope listed above and every collected trial
row, including practice attempts, Korean text, multiple emotion keywords,
keyword add/remove events, raw responses, derived ratings, stimulus identifiers,
questionnaire data, and timestamps. CSV conversion can be done later for analysis
without flattening or dropping nested data during collection.

Only consented sessions ending with an acknowledged debrief upload. Early exits
and unfinished sessions are not uploaded. There is no ongoing autosave, browser
storage, local-download fallback, or reload recovery. Closing or reloading before
confirmed submission can lose unsaved responses. Data remain in memory while the
page stays open. The complete encoded request is checked against a conservative
32,000,000-byte limit; oversize or unserializable data fail visibly without upload.

### Confirmation, errors, and retries

`uploadCompletedSession()` sends a JSON request to
`https://pipe.jspsych.org/api/data/` with `experimentID`, `filename`, and `data`
(the file contents as a JSON string). It waits up to 30 seconds, including reading
the response. Only HTTP 201 with `message: "Success"`, no `error` field, and no
queued indication is accepted as confirmation. HTTP success alone is insufficient.

- During upload, further submissions are blocked. After confirmed success,
  neither another click nor another completion callback can send the file again.
- Network errors, timeouts, transient service failures, or unexpected confirmation
  responses show that saving is unconfirmed. The participant can deliberately
  retry after a five-second cooldown. The timer only enables the button; there
  is no automatic browser retry. Every attempt uses the identical request body,
  filename, session ID, and completion timestamp.
- Configuration/validation rejections require researcher intervention; the page
  does not repeatedly retry invalid data or settings.
- HTTP 202 or an explicit queued response is not confirmed OSF storage. DataPipe
  may retry queued files itself. The page blocks competing submissions and asks
  the participant to contact the researcher using the displayed session reference.
- `OSF_FILE_EXISTS` also blocks further submission. An existing filename does
  not prove that its contents match this session. Never rename the file merely
  to bypass the duplicate check.

A browser timeout does not undo a request the server already received. For an
ambiguous result, inspect the DataPipe queue/logs and the OSF file identified by
the session ID. Compare its contents before classifying the session as saved.
This client cannot guarantee exactly-once delivery or independently verify an
existing private OSF file. It does not poll the queue or mark a queued/duplicate
result successful. DataPipe's service-managed retries are distinct from the
browser retry button and may continue after the participant leaves.

### Verification procedure

Serve the survey over local HTTP for browser checks. Automated checks must
intercept all DataPipe requests and return simulated responses; never run an
unintercepted completed survey as a test. Exercise both conditions and compare
the full serialized trial collection with the original, including Unicode and
nested arrays. Check consent/eligibility exits, repeated practice, concurrent
clicks, stable retries, and success, rejection, queue, duplicate, malformed-response,
network-error, and timeout paths. Confirm that the original questions, audio,
timing, condition settings, and timeline have not changed.

Simulated responses validate client behavior only. With separate approval for
real test submissions, inspect DataPipe settings, upload clearly identified
synthetic sessions, and compare the downloaded OSF JSON with the expected data.
Live confirmation, permissions, service recovery, and the destination cannot be
verified solely by local tests. Never commit participant data or credentials.

Official references:

- [DataPipe setup](https://pipe.jspsych.org/getting-started)
- [DataPipe API](https://pipe.jspsych.org/api-docs)
- [DataPipe limits and queued delivery](https://pipe.jspsych.org/faq)
- [DataPipe upload implementation and HTTP statuses](https://github.com/jspsych/datapipe/blob/main/functions/src/api-data.ts)
- [jsPsych data handling](https://www.jspsych.org/v8/overview/data/)
- [OSF Project API transition](https://help.osf.io/article/744-osf-projects-api-impact)
