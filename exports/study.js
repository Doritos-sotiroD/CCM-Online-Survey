// Analysis CSVs are projections of the raw snapshot; never mutate collected rows.
const DIMENSIONS = [
  ["arousal", "stimulation"], ["attention", "focus"], ["certainty", "certainty"],
  ["commitment", "person_commitment"], ["dominance", "dominance"],
  ["identity", "group_identity"], ["obstruction", "obstruction"],
  ["safety", "safety"], ["valence", "pleasantness"]
];

function csv(headers, records) {
  const cell = value => '"' + String(value).replace(/"/g, '""') + '"';
  return [headers, ...records].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

function validateSnapshot(rows, metadata) {
  if (!Array.isArray(rows) || rows.some(row => row === null || typeof row !== "object") ||
      typeof metadata?.session_id !== "string" || !metadata.session_id ||
      !["condition_1", "condition_2"].includes(metadata.condition) ||
      !Number.isInteger(metadata.sessions_completed) ||
      metadata.sessions_completed < 0 || metadata.sessions_completed > 2 ||
      typeof metadata.verification_skip_sessions !== "boolean" ||
      (metadata.verification_skip_sessions ? metadata.sessions_completed !== 0 : metadata.sessions_completed === 0) ||
      rows.some(row => row.session_id !== metadata.session_id || row.condition !== metadata.condition)) {
    throw new Error("STUDY_EXPORT_METADATA_INVALID");
  }
}

function rating(row, name, derivedColumn) {
  const raw = row.response?.[name];
  if (!Number.isInteger(raw) || raw < 0 || raw > 8 || row[derivedColumn] !== raw + 1) {
    throw new Error("STUDY_EXPORT_RATING_INVALID");
  }
  return raw + 1;
}

function musicTrials(rows, metadata) {
  const tasks = ["excerpt_listening", "free_response", "dimensional_rating", "familiarity"];
  const main = rows.filter(row => row.phase === "main" && tasks.includes(row.task));
  if (main.length !== metadata.sessions_completed * 30 * 3) {
    throw new Error("STUDY_EXPORT_TRIALS_INCOMPLETE");
  }
  const emotionTask = metadata.condition === "condition_1" ? "free_response" : "dimensional_rating";
  const trials = [];
  for (let i = 0; i < main.length; i += 3) {
    const [listening, emotion, familiarity] = main.slice(i, i + 3);
    const sessionNumber = Math.floor(i / 90) + 1;
    if (listening.task !== "excerpt_listening" || emotion.task !== emotionTask || familiarity.task !== "familiarity" ||
        typeof listening.work_id !== "string" || !listening.work_id.trim() ||
        typeof listening.stimulus_id !== "string" || !listening.stimulus_id.trim() ||
        [listening, emotion, familiarity].some(row =>
          row.session_number !== sessionNumber || row.work_id !== listening.work_id ||
          row.stimulus_id !== listening.stimulus_id)) {
      throw new Error("STUDY_EXPORT_TRIAL_IDENTITY_INVALID");
    }
    const started = listening.excerpt_ended_at_ms;
    const finished = familiarity.familiarity_completed_at_ms;
    const seconds = familiarity.response_time_seconds;
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started ||
        !Number.isFinite(seconds) || seconds !== (finished - started) / 1000) {
      throw new Error("STUDY_EXPORT_TIMING_INVALID");
    }
    let responses;
    if (metadata.condition === "condition_1") {
      responses = emotion.emotion_keywords;
      if (!Array.isArray(responses) || responses.length === 0 ||
          responses.some(word => typeof word !== "string" || !word.trim()) ||
          emotion.keyword_count !== responses.length) {
        throw new Error("STUDY_EXPORT_KEYWORDS_INVALID");
      }
    } else {
      responses = DIMENSIONS.map(([, name]) => rating(emotion, name, "rating_" + name));
    }
    trials.push({
      work_id: listening.work_id, responses,
      familiarity: rating(familiarity, "familiarity", "familiarity_rating_1_to_9"),
      response_time_seconds: seconds
    });
  }
  return trials;
}

export function createExperimentCsv(rows, metadata) {
  validateSnapshot(rows, metadata);
  const trials = musicTrials(rows, metadata);
  const responseColumns = metadata.condition === "condition_1"
    ? Array.from({length: Math.max(0, ...trials.map(trial => trial.responses.length))}, (_, i) => "emotion_" + (i + 1))
    : DIMENSIONS.map(([column]) => column);
  const headers = ["trial_no", "work_id", "session_id", ...responseColumns, "familiarity", "response_time_seconds"];
  return csv(headers, trials.map((trial, index) => [
    index + 1, trial.work_id, metadata.session_id,
    ...responseColumns.map((_, responseIndex) => trial.responses[responseIndex] ?? ""),
    trial.familiarity, trial.response_time_seconds
  ]));
}

export function createProceduralCsv(rows, metadata) {
  validateSnapshot(rows, metadata);
  musicTrials(rows, metadata);
  const consent = rows.filter(row => row.task === "consent");
  const eligibility = rows.filter(row => row.task === "eligibility");
  const eligibilityFields = ["eligibility_1", "eligibility_2", "eligibility_3", "eligibility_4"];
  const debrief = rows.at(-1);
  if (consent.length !== 1 || consent[0].consented !== true || consent[0].response?.consent_decision !== "agree" ||
      eligibility.length !== 1 ||
      eligibilityFields.some(field => !["yes", "no"].includes(eligibility[0].response?.[field])) ||
      debrief?.task !== "debrief" || debrief.debrief_acknowledged !== true ||
      !Number.isFinite(debrief.time_elapsed) || debrief.time_elapsed < 0) {
    throw new Error("PROCEDURAL_EXPORT_COMPLETION_INVALID");
  }
  const contact = rows.filter(row => row.task === "contact_information");
  if (contact.length !== 1 ||
      typeof contact[0].response?.phone_number !== "string" ||
      typeof contact[0].response?.email_address !== "string") {
    throw new Error("PROCEDURAL_EXPORT_CONTACT_INVALID");
  }
  const instructions = rows.filter(row => row.task === "instructions");
  const practice = rows.filter(row => row.phase === "practice" && row.task === "practice_decision");
  const familiarity = rows.filter(row => row.phase === "practice" && row.task === "familiarity");
  if (metadata.verification_skip_sessions
      ? instructions.length !== 0 || practice.length !== 0 || familiarity.length !== 0
      : instructions.length !== 1 || practice.length === 0 || familiarity.length !== practice.length) {
    throw new Error("PROCEDURAL_EXPORT_PRACTICE_INVALID");
  }
  if (instructions.some(row => !Number.isFinite(row.rt) || row.rt < 0 || row.rt > debrief.time_elapsed) ||
      practice.some((row, index) => row.practice_attempt !== index + 1 ||
        familiarity[index]?.practice_attempt !== index + 1 || typeof row.repeat_practice !== "boolean" ||
        row.repeat_practice !== (index < practice.length - 1))) {
    throw new Error("PROCEDURAL_EXPORT_PRACTICE_INVALID");
  }
  const record = {
    session_id: metadata.session_id,
    // A verification run is assigned a condition but completes no music task.
    condition: metadata.sessions_completed === 0 ? "" : metadata.condition,
    sessions_completed: metadata.sessions_completed,
    overall_duration_minutes: debrief.time_elapsed / 60000,
    consented: consent[0].consented,
    eligibility_1: eligibility[0].response.eligibility_1,
    eligibility_2: eligibility[0].response.eligibility_2,
    eligibility_3: eligibility[0].response.eligibility_3,
    eligibility_4: eligibility[0].response.eligibility_4,
    instruction_duration_minutes: instructions.reduce((sum, row) => sum + row.rt, 0) / 60000,
    practice_sessions_completed: practice.length,
    phone_number: contact[0].response.phone_number,
    email_address: contact[0].response.email_address
  };
  return csv(Object.keys(record), [Object.values(record)]);
}
