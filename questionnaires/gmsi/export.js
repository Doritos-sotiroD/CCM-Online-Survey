import {
  QUESTIONNAIRE_ID, QUESTIONNAIRE_VERSION, CODING_VERSION, ITEM_IDS, PAGE_SIZE,
  validateGmsiDataset, decodeGmsiPage, isGmsiRow
} from "./questionnaire.js";

// Scorer input: one session_id and exactly 18 unreversed, numeric 1–7 item codes.
export function createGmsiCsv(rows, dataset, metadata) {
  validateGmsiDataset(dataset, dataset?.language);
  const pageCount = ITEM_IDS.length / PAGE_SIZE;
  const pages = rows.filter(isGmsiRow);
  if (pages.length !== pageCount) throw new Error("GMSI_EXPORT_INCOMPLETE");
  if (typeof metadata.session_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(metadata.session_id) ||
      !["condition_1", "condition_2"].includes(metadata.condition)) {
    throw new Error("GMSI_EXPORT_METADATA_INVALID");
  }
  const answers = pages.flatMap((page, index) => {
    if (page.gmsi_page !== index + 1 || page.gmsi_page_count !== pageCount ||
        page.session_id !== metadata.session_id || page.condition !== metadata.condition ||
        page.questionnaire_id !== QUESTIONNAIRE_ID ||
        page.questionnaire_language !== dataset.language ||
        page.questionnaire_version !== QUESTIONNAIRE_VERSION ||
        page.questionnaire_coding_version !== CODING_VERSION) {
      throw new Error("GMSI_EXPORT_PAGE_INVALID");
    }
    const decoded = decodeGmsiPage(dataset, index + 1, page.response);
    if (JSON.stringify(decoded) !== JSON.stringify(page.gmsi_answers)) {
      throw new Error("GMSI_EXPORT_ANSWERS_MISMATCH");
    }
    return decoded;
  });
  if (!Number.isFinite(Date.parse(pages[pageCount - 1].gmsi_completed_at))) {
    throw new Error("GMSI_EXPORT_COMPLETION_INVALID");
  }
  const cell = value => '"' + String(value).replace(/"/g, '""') + '"';
  return ["session_id", ...ITEM_IDS].map(cell).join(",") + "\r\n" +
    [metadata.session_id, ...answers.map(answer => answer.response_1_to_7)].map(cell).join(",") + "\r\n";
}
