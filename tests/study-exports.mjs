import test from "node:test";
import assert from "node:assert/strict";
import {createExperimentCsv, createProceduralCsv} from "../exports/study.js";
import {musicRows, practiceRows, parseStudyCsv} from "./study-fixtures.mjs";

function complete(condition = "condition_1", sessions = 2, skip = false) {
  const metadata = {session_id: "TEST_STUDY_EXPORT", condition, sessions_completed: sessions, verification_skip_sessions: skip};
  const rows = [
    {...metadata, task: "consent", consented: true, response: {consent_decision: "agree"}},
    {...metadata, task: "eligibility", response: {
      eligibility_1: "yes", eligibility_2: "no", eligibility_3: "no", eligibility_4: "no", eligibility_5: "yes"
    }},
    {...metadata, task: "demographics", response: {age: "23"}},
    ...(skip ? [] : practiceRows(metadata)),
    ...musicRows(metadata, sessions),
    {...metadata, task: "musical_sophistication", response: {AE_01: 3}},
    {...metadata, task: "personality_traits", response: {TEST_ITEM: 3}},
    {...metadata, task: "debrief", debrief_acknowledged: true, time_elapsed: 1200000}
  ];
  return {rows, metadata};
}

test("Condition 1 exports one row per clip in presentation order, padded final emotion cells and exact seconds", () => {
  const {rows, metadata} = complete();
  const before = structuredClone(rows);
  const parsed = parseStudyCsv(createExperimentCsv(rows, metadata));
  assert.deepEqual(parsed[0], ["trial_no", "work_id", "session_id", "emotion_1", "emotion_2", "emotion_3", "familiarity", "response_time_seconds"]);
  assert.equal(parsed.length, 61);
  assert.deepEqual(parsed.slice(1).map(row => Number(row[0])), Array.from({length: 60}, (_, i) => i + 1));
  assert.equal(parsed[1][1], "TEST_WORK_60");
  assert.deepEqual(parsed[1].slice(3, 6), ["기쁨", "평온", "놀람"]);
  assert.deepEqual(parsed[2].slice(3, 6), ['슬픔, "기쁨"\n잔잔함', "", ""]);
  assert.equal(Number(parsed[1].at(-1)), 12.345678);
  assert.deepEqual(rows, before);
});

test("Condition 2 maps every renamed dimension in the requested order using 1–9 scores", () => {
  const {rows, metadata} = complete("condition_2", 1);
  const before = structuredClone(rows);
  const parsed = parseStudyCsv(createExperimentCsv(rows, metadata));
  assert.deepEqual(parsed[0], ["trial_no", "work_id", "session_id", "arousal", "attention", "certainty", "commitment", "dominance", "identity", "obstruction", "safety", "valence", "familiarity", "response_time_seconds"]);
  assert.equal(parsed.length, 31);
  assert.deepEqual(parsed[1].slice(3, 12).map(Number), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(Number(parsed[9][12]), 9);
  assert.deepEqual(rows, before);
});

test("procedural CSV contains just one summary with final counts and durations in minutes", () => {
  for (const condition of ["condition_1", "condition_2"]) {
    const {rows, metadata} = complete(condition);
    const before = structuredClone(rows);
    const parsed = parseStudyCsv(createProceduralCsv(rows, metadata));
    assert.deepEqual(parsed[0], ["session_id", "condition", "sessions_completed", "overall_duration_minutes", "consented", "eligibility_1", "eligibility_2", "eligibility_3", "eligibility_4", "eligibility_5", "instruction_duration_minutes", "practice_sessions_completed"]);
    assert.deepEqual(parsed[1], [metadata.session_id, condition, "2", "20", "true", "yes", "no", "no", "no", "yes", "0.75", "2"]);
    assert.equal(parsed.length, 2);
    assert.deepEqual(rows, before);
  }
});

test("verification exports have no invented trial rows, completed condition or practice", () => {
  for (const condition of ["condition_1", "condition_2"]) {
    const {rows, metadata} = complete(condition, 0, true);
    assert.equal(parseStudyCsv(createExperimentCsv(rows, metadata)).length, 1);
    const parsed = parseStudyCsv(createProceduralCsv(rows, metadata));
    assert.deepEqual(parsed[1], [metadata.session_id, "", "0", "20", "true", "yes", "no", "no", "no", "yes", "0", "0"]);
  }
});

test("missing, misordered, mismatched, invalid or incorrectly timed trials fail instead of exporting partial rows", () => {
  const mutations = [
    rows => rows.splice(rows.findIndex(row => row.phase === "main"), 1),
    rows => rows.find(row => row.phase === "main").work_id = "",
    rows => rows.find(row => row.phase === "main" && row.task === "familiarity").work_id = "OTHER",
    rows => rows.find(row => row.phase === "main").session_number = 2,
    rows => rows.find(row => row.phase === "main").session_id = "OTHER",
    rows => rows.find(row => row.phase === "main").condition = "condition_2",
    rows => rows.find(row => row.phase === "main" && row.task === "free_response").emotion_keywords = [],
    rows => rows.find(row => row.phase === "main" && row.task === "familiarity").response.familiarity = 9,
    rows => rows.find(row => row.phase === "main" && row.task === "familiarity").response_time_seconds = 2,
    rows => delete rows.find(row => row.phase === "main").excerpt_ended_at_ms
  ];
  for (const mutate of mutations) {
    const {rows, metadata} = complete(); mutate(rows);
    assert.throws(() => createExperimentCsv(rows, metadata), /STUDY_EXPORT_/);
  }
  const {rows, metadata} = complete("condition_2");
  rows.find(row => row.task === "dimensional_rating").rating_focus = 0;
  assert.throws(() => createExperimentCsv(rows, metadata), /RATING_INVALID/);
});

test("all eligibility answer combinations export unchanged without an exclusion decision", () => {
  for (const condition of ["condition_1", "condition_2"]) for (let mask = 0; mask < 32; mask++) {
    const {rows, metadata} = complete(condition);
    const answers = Array.from({length: 5}, (_, index) => mask & (1 << index) ? "yes" : "no");
    rows[1].response = Object.fromEntries(answers.map((answer, index) => [`eligibility_${index + 1}`, answer]));
    const before = structuredClone(rows);
    const parsed = parseStudyCsv(createProceduralCsv(rows, metadata));
    assert.deepEqual(parsed[1].slice(5, 10), answers);
    assert.equal(parsed[0].includes("eligible"), false);
    assert.deepEqual(rows, before);
  }
});

test("procedure export rejects incomplete consent, eligibility, practice and endpoint timing", () => {
  const mutations = [
    rows => rows[0].consented = false,
    ...Array.from({length: 5}, (_, index) => rows => { delete rows[1].response[`eligibility_${index + 1}`]; }),
    ...Array.from({length: 5}, (_, index) => rows => { rows[1].response[`eligibility_${index + 1}`] = "invalid"; }),
    rows => rows.at(-1).debrief_acknowledged = false,
    rows => rows.at(-1).time_elapsed = NaN,
    rows => rows.find(row => row.task === "instructions").rt = -1,
    rows => rows.find(row => row.task === "practice_decision").practice_attempt = 3,
    rows => rows.splice(rows.findIndex(row => row.phase === "practice" && row.task === "familiarity"), 1)
  ];
  for (const mutate of mutations) {
    const {rows, metadata} = complete(); mutate(rows);
    assert.throws(() => createProceduralCsv(rows, metadata), /PROCEDURAL_EXPORT_/);
  }
});
