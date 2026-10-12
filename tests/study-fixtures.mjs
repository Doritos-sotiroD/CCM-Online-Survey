// Synthetic records only. These fixtures are never sent to DataPipe.
export function musicRows(properties, sessions = 1) {
  const dimensions = ["stimulation", "focus", "certainty", "person_commitment", "dominance",
    "group_identity", "obstruction", "safety", "pleasantness"];
  return Array.from({length: sessions * 30}, (_, i) => {
    const identity = {
      ...properties, phase: "main", session_number: Math.floor(i / 30) + 1,
      work_id: "TEST_WORK_" + (60 - i), stimulus_id: String(60 - i).padStart(4, "0"),
      source_index: 30 - i % 30, audio_file: "audio/test.mp3"
    };
    const emotion = properties.condition === "condition_1"
      ? {task: "free_response", emotion_keywords: i % 2 ? ['슬픔, "기쁨"\n잔잔함'] : ["기쁨", "평온", "놀람"], keyword_count: i % 2 ? 1 : 3}
      : {task: "dimensional_rating", response: Object.fromEntries(dimensions.map((name, index) => [name, (i + index) % 9])),
        ...Object.fromEntries(dimensions.map((name, index) => ["rating_" + name, (i + index) % 9 + 1]))};
    const ended = 10000 + i * 20000;
    const finished = ended + 12345.678;
    return [
      {...identity, task: "excerpt_listening", excerpt_ended_at_ms: ended},
      {...identity, ...emotion},
      {...identity, task: "familiarity", response: {familiarity: i % 9},
        familiarity_rating_1_to_9: i % 9 + 1, rt: 2000,
        familiarity_completed_at_ms: finished, response_time_seconds: (finished - ended) / 1000}
    ];
  }).flat();
}

export function practiceRows(properties, attempts = 2) {
  return [
    {...properties, task: "instructions", phase: "practice", rt: 45000,
      view_history: [{page_index: 0, viewing_time: 15000}, {page_index: 1, viewing_time: 20000}, {page_index: 0, viewing_time: 10000}]},
    ...Array.from({length: attempts}, (_, i) => [
      {...properties, task: "practice_start", phase: "practice", practice_attempt: i + 1},
      {...properties, task: "familiarity", phase: "practice", practice_attempt: i + 1},
      {...properties, task: "practice_decision", phase: "practice", practice_attempt: i + 1,
        repeat_practice: i < attempts - 1}
    ]).flat()
  ];
}

export function parseStudyCsv(text) {
  const result = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {cell += '"'; i++;}
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {row.push(cell); cell = "";}
    else if (c === "\n") {row.push(cell); result.push(row); row = []; cell = "";}
    else if (c !== "\r") cell += c;
  }
  if (quoted || row.length || cell) throw new Error("TEST_CSV_INCOMPLETE");
  return result;
}
