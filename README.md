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
- If validation is enabled, allow BOTH JSON and CSV. The JSON file is an object whose
  top-level fields are `session_id`, `experiment_version`, `condition`,
  `completed_at`, and `trials`. Shared required-field rules must also match CSV
  column names: `session_id` works for both; `trials` exists only in JSON and must
  not be required. Check optional metadata-generation settings for compatibility
  with both formats before a pilot.
- DataPipe counts each successful/queued file request toward its session limit.
  Budget two uploads per participant: a limit of 50 allows about 25 complete
  pairs, fewer if other uploads have consumed the allowance. Adjust the dashboard
  limit for planned participants, existing usage, and test uploads. The browser
  cannot reserve two slots or guarantee an atomic pair of uploads.
- This survey does not call DataPipe's condition-assignment or base64 endpoints.
  Its existing condition assignment and trial sequence remain in the survey.
- Approve the destination and filenames for synthetic pilot uploads first.
  Verify one complete session from each condition by inspecting the actual OSF
  JSON/CSV file pairs, not just the completion screen. Use a separate test experiment or
  clearly identified `TEST_` filenames in an isolated test harness; the production
  survey has no test-mode URL switch.
- OSF states that new Projects/Components cannot be created from November 16,
  2026 and existing Projects become read-only on February 19, 2027. Confirm that
  the collection schedule fits this service limitation. Do not assume DataPipe
  can continue uploading to OSF Projects after that date.

### What is saved and when

After the participant acknowledges the debrief, `finishSurveyAndSave()` creates
one snapshot and prepares two UTF-8 files before uploading either:
`CCM_<experiment_version>_<session_id>.json` and
`CCM_<experiment_version>_<session_id>.csv`. The existing random 16-character
session ID is generated once per page load and remains attached to every trial.
Filename collisions are errors, never permission to overwrite a file.

The JSON file retains the existing envelope listed above and every collected trial
row, including practice attempts, Korean text, multiple emotion keywords,
keyword add/remove events, raw responses, derived ratings, stimulus identifiers,
questionnaire data, and timestamps. CSV has one row per trial, using jsPsych's
built-in exporter on a copy of the same snapshot. Each CSV row also receives the
same `completed_at` value from the JSON envelope. Original trial data are not
modified. Nested objects and arrays (responses, keyword lists/events, rating
schemas) remain JSON text inside quoted CSV cells. CSV preserves their contents
but does not retain all scalar type distinctions; the JSON file is the full
structured record. Import CSV as UTF-8 when opening it in a spreadsheet program.

Only consented sessions ending with an acknowledged debrief upload. Early exits
and unfinished sessions are not uploaded. There is no ongoing autosave, browser
storage, local-download fallback, or reload recovery. Closing or reloading before
confirmed submission can lose unsaved responses. Data remain in memory while the
page stays open. Each complete encoded request is checked against a conservative
32,000,000-byte limit. If either file cannot be prepared, neither is uploaded.

### Confirmation, errors, and retries

`uploadCompletedSession()` sends a JSON request to
`https://pipe.jspsych.org/api/data/` with `experimentID`, `filename`, and `data`
(the JSON or CSV file contents as a string). JSON is uploaded first, then CSV,
with up to 30 seconds per request, including reading the response. Both requests
still use `Content-Type: application/json`. Only HTTP 201 with `message: "Success"`, no `error` field, and no
queued indication is accepted as confirmation. HTTP success alone is insufficient.
Overall completion requires confirmation for BOTH files. The screen shows each
file's state and includes the failing format alongside its diagnostic code.
If JSON saves but CSV fails, JSON stays saved and the page reports the partial
result; it does not delete the first file or claim full submission success.

- During upload, further submissions are blocked. After confirmed success,
  neither another click nor another completion callback can send the file again.
- Network errors, timeouts, transient service failures, or unexpected confirmation
  responses show that saving is unconfirmed. The participant can deliberately
  retry after a five-second cooldown. The timer only enables the button; there
  is no automatic browser retry. Every attempt uses the identical request body,
  filename, session ID, and completion timestamp for that file. Confirmed files
  are skipped on retry. Uploads stop at the first failure; if JSON fails, CSV has
  not yet been sent. A lost confirmation can still produce a duplicate on retry,
  requiring researcher inspection rather than a new filename.
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

### Submission diagnostic codes

Every handled saving failure now displays `오류 코드:` (error code). If a response
arrived, the code includes its HTTP status, for example
`DP_INVALID_DATA (HTTP 400)`. Ask for this code and the displayed session reference.
The reference identifies the expected file; it is not proof that the file exists.
Codes identify the failing step or DataPipe's reported error, not necessarily the
underlying cause. An error before any HTTP response has no HTTP status to show.

| Code | Failing step / next check |
| --- | --- |
| `SAVE_CONFIG_ENDPOINT` | The configured DataPipe URL is incorrect. |
| `SAVE_CONFIG_EXPERIMENT_ID` | The local experiment ID is missing or malformed. A valid-looking ID still requires remote verification. |
| `SAVE_CONFIG_TIMEOUT` | The upload timeout is not a positive integer. |
| `SAVE_CONFIG_RETRY_DELAY` | The retry delay is not an integer of at least 5,000 ms. |
| `SAVE_BROWSER_FETCH` | The browser lacks the request API. |
| `SAVE_BROWSER_ABORT` | The browser lacks the request cancellation API. |
| `SAVE_BROWSER_ENCODING` | The browser lacks the UTF-8 encoding API. |
| `SAVE_DATA_READ` | The survey could not read its collected trial rows. No upload starts. |
| `SAVE_DATA_SERIALIZE` | The survey could not turn the completed data into JSON. |
| `SAVE_CSV_SERIALIZE` | The survey could not generate the CSV copy. Neither file was uploaded. |
| `SAVE_REQUEST_SERIALIZE` | The survey could not package the file and request fields into JSON. |
| `SAVE_REQUEST_ENCODING` | The request's UTF-8 byte-size check failed. |
| `SAVE_REQUEST_TOO_LARGE` | The encoded request reaches the 32,000,000-byte limit. |
| `SAVE_CONNECTION` | No response was received. Check connectivity and the browser Network panel; JavaScript cannot reliably separate offline, DNS, CORS, TLS, and blocked-redirect failures. |
| `SAVE_REQUEST_TIMEOUT` | The 30-second deadline expired before response headers arrived. The server may already have the file. |
| `SAVE_RESPONSE_TIMEOUT` | The deadline expired while reading the response body. The server may already have the file. |
| `SAVE_RESPONSE_READ` | Response headers arrived but reading the body failed. |
| `SAVE_RESPONSE_JSON` | The response body is not valid JSON. Inspect the actual POST response privately. |
| `SAVE_QUEUED` | HTTP 202 or an explicit queue indication: DataPipe has not confirmed OSF storage. Do not submit again; check its queue and OSF. |
| `SAVE_HTTP_CONFLICT` | HTTP 409: a conflict blocks retries, even if the response body is unreadable. Check the expected OSF file. |
| `SAVE_HTTP_ERROR` | HTTP failure without a recognized string error field; the displayed status helps locate the problem. |
| `SAVE_REMOTE_UNKNOWN` | DataPipe returned a string error outside the known-code list. Inspect the actual POST response privately. |
| `SAVE_CONFIRMATION` | A readable response did not meet the exact success requirements. Storage remains unconfirmed. |
| `SAVE_UNEXPECTED` | An otherwise unclassified exception interrupted submission. Investigate the saving code. |

Known public DataPipe errors have their own branch using the prefix `DP_`:

| Code(s), all prefixed with `DP_` | Next check |
| --- | --- |
| `MISSING_PARAMETER` | Inspect the survey's actual POST for `experimentID`, `filename`, and `data`. Opening the endpoint URL directly sends an empty GET and does not diagnose the survey's POST. |
| `EXPERIMENT_NOT_FOUND`, `EXPERIMENT_DATA_NOT_FOUND` | Verify the experiment ID and experiment record in DataPipe. |
| `DATA_COLLECTION_NOT_ACTIVE` | Enable text-data collection in the intended DataPipe experiment. |
| `SESSION_LIMIT_REACHED` | Check the experiment's remaining allowance. |
| `INVALID_DATA` | Check that both formats are allowed and required fields match both the JSON envelope and CSV headers. |
| `USER_DATA_NOT_FOUND`, `INVALID_OWNER` | Check the DataPipe owner's account and experiment ownership. |
| `INVALID_OSF_TOKEN`, `INVALID_REFRESH_TOKEN`, `NOT_USING_OAUTH`, `OAUTH_NOT_SETUP`, `TOKEN_RESOLUTION_ERROR` | Check/reconnect OSF authorization in DataPipe; never add a token to this HTML. |
| `OSF_FILE_EXISTS` | Inspect the existing file and compare contents; another upload is blocked. |
| `OSF_UPLOAD_ERROR`, `OSF_UPLOAD_EXCEPTION` | DataPipe reported trouble writing to OSF. Check destination permissions, capacity, and service status; storage is unconfirmed. |
| `INVALID_METADATA_ERROR`, `OSF_METADATA_UPLOAD_ERROR`, `METADATA_ERROR` | Check optional metadata settings and whether the main file was already stored. |
| `DATA_PERSIST_ERROR` | DataPipe reported a failure to persist data; researcher investigation is required. |
| `BASE64DATA_COLLECTION_NOT_ACTIVE`, `CONDITION_ASSIGNMENT_NOT_ACTIVE`, `INVALID_BASE64_DATA`, `UNKNOWN_ERROR_GETTING_CONDITION` | Unexpected for this text-upload endpoint; verify the endpoint and service response. |

The screen uses fixed codes and HTTP status, never raw exception messages,
server messages, or response bodies that might include sensitive information.
Unknown server strings deliberately use `SAVE_REMOTE_UNKNOWN`. Diagnostics are
not added to participant data or saved elsewhere. A retry clears the previous
code while waiting and shows a new code if it fails. All existing retry rules
above still apply; diagnostics do not trigger requests or turn failure into success.

### Verification procedure

Serve the survey over local HTTP for browser checks. Automated checks must
intercept all DataPipe requests and return simulated responses; never run an
unintercepted completed survey as a test. Exercise both conditions and compare
the full serialized trial collection with the original, including Unicode and
nested arrays. Check consent/eligibility exits, repeated practice, concurrent
clicks, stable retries, and success, rejection, queue, duplicate, malformed-response,
network-error, and timeout paths. Confirm that the original questions, audio,
timing, condition settings, and timeline have not changed.
Check the specific diagnostic code and HTTP status for every branch, including
each known DataPipe rejection, unavailable browser APIs, data preparation errors,
timeouts before/after headers, non-JSON responses, and unexpected exceptions.
Unknown/raw server messages must not appear on screen. After a successful retry,
the old error code must be cleared. A malformed HTTP 409 response must still
block another submission.
Exercise failures at both file positions, especially JSON saved / CSV failed,
and confirm retry never resends a confirmed JSON file. Parse CSV independently
and compare every cell/row with the JSON snapshot, including nested values,
Unicode, commas, quotes, line breaks, nulls, and empty values. Verify that a CSV
preparation/size failure prevents both uploads and that no success appears while
the second upload is pending, queued, rejected, or unconfirmed.

Simulated responses validate client behavior only. With separate approval for
real test submissions, inspect DataPipe settings, upload clearly identified
synthetic sessions, and compare both downloaded OSF files with the expected data.
Live confirmation, permissions, service recovery, and the destination cannot be
verified solely by local tests. Never commit participant data or credentials.

Official references:

- [DataPipe setup](https://pipe.jspsych.org/getting-started)
- [DataPipe API](https://pipe.jspsych.org/api-docs)
- [DataPipe limits and queued delivery](https://pipe.jspsych.org/faq)
- [DataPipe upload implementation and HTTP statuses](https://github.com/jspsych/datapipe/blob/main/functions/src/api-data.ts)
- [jsPsych data handling](https://www.jspsych.org/v8/overview/data/)
- [OSF Project API transition](https://help.osf.io/article/744-osf-projects-api-impact)
