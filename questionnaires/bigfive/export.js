import {
  QUESTIONNAIRE_ID, QUESTIONNAIRE_VERSION, SOURCE_COMMIT, PAGE_SIZE, decodeBigFivePage, isBigFiveRow
} from "./questionnaire.js";
import { DOMAINS, SCORING_VERSION, scoreBigFive } from "./scoring.js";

// One participant row, keyed by the same session_id as the main response file.
// This also verifies completeness before any study files are uploaded.
export function createBigFiveCsv(rows, dataset, metadata) {
  const pages = rows.filter(isBigFiveRow);
  const pageCount = dataset.items.length / PAGE_SIZE;
  if (pages.length !== pageCount) {
    throw new Error("BIGFIVE_EXPORT_INCOMPLETE");
  }
  if (typeof metadata.session_id !== "string" || !metadata.session_id ||
      typeof metadata.experiment_version !== "string" || !metadata.experiment_version ||
      !["condition_1", "condition_2"].includes(metadata.condition) ||
      !Number.isInteger(metadata.sessions_completed) || metadata.sessions_completed < 0 || metadata.sessions_completed > 2 ||
      typeof metadata.verification_skip_sessions !== "boolean" ||
      !Number.isFinite(Date.parse(metadata.completed_at))) {
    throw new Error("BIGFIVE_EXPORT_METADATA_INVALID");
  }
  const answers = pages.flatMap((page, index) => {
    if (page.bigfive_page !== index + 1 || page.bigfive_page_count !== pageCount ||
        page.session_id !== metadata.session_id || page.condition !== metadata.condition ||
        page.questionnaire_language !== dataset.language ||
        page.questionnaire_version !== QUESTIONNAIRE_VERSION ||
        page.questionnaire_source_commit !== SOURCE_COMMIT ||
        page.questionnaire_scoring_version !== SCORING_VERSION) {
      throw new Error("BIGFIVE_EXPORT_PAGE_INVALID");
    }
    const decoded = decodeBigFivePage(dataset, index + 1, page.response);
    if (JSON.stringify(decoded) !== JSON.stringify(page.bigfive_answers)) {
      throw new Error("BIGFIVE_EXPORT_ANSWERS_MISMATCH");
    }
    return decoded;
  });
  const result = scoreBigFive(answers);
  const lastPage = pages[pages.length - 1];
  if (JSON.stringify(result) !== JSON.stringify(lastPage.bigfive_result) ||
      !Number.isFinite(Date.parse(lastPage.bigfive_completed_at))) {
    throw new Error("BIGFIVE_EXPORT_RESULT_INVALID");
  }
  const record = {
    ...metadata,
    trial_type: "survey-likert",
    task: "personality_traits",
    questionnaire_id: QUESTIONNAIRE_ID,
    questionnaire_version: lastPage.questionnaire_version,
    questionnaire_source_commit: SOURCE_COMMIT,
    questionnaire_scoring_version: SCORING_VERSION,
    questionnaire_language: dataset.language,
    bigfive_completed_at: lastPage.bigfive_completed_at,
    item_count: answers.length,
    scale_labels: dataset.choices.plus.map(choice => choice.text),
    // Includes exact item/choice wording, keys, IDs, facets, and both raw/derived values.
    item_responses: answers,
    page_responses: pages.map(page => ({
      page: page.bigfive_page, response: page.response, rt: page.rt,
      time_elapsed: page.time_elapsed, question_order: page.question_order
    }))
  };
  for (const answer of answers) {
    const prefix = `item_${answer.id}`;
    record[`${prefix}_response_index`] = answer.response_index;
    record[`${prefix}_response_1_to_5`] = answer.response_1_to_5;
    record[`${prefix}_score`] = answer.score;
  }
  for (const name of DOMAINS) {
    for (const field of ["score", "count", "result"]) {
      record[`${name}_${field}`] = result[name][field];
      for (let facet = 1; facet <= 6; facet++) {
        record[`${name}${facet}_${field}`] = result[name].facet[facet][field];
      }
    }
  }
  function cell(value) {
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return Object.keys(record).map(cell).join(",") + "\r\n" +
    Object.values(record).map(cell).join(",") + "\r\n";
}
