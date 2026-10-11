export const QUESTIONNAIRE_ID = "gold_msi_general_18";
export const QUESTIONNAIRE_VERSION = "gold_msi_general_18_v1";
export const CODING_VERSION = "gold_msi_unreversed_1_to_7_v1";
export const PAGE_SIZE = 9;

// CSV order, Korean appendix number, response scale, and reverse key.
const ITEM_DEFINITIONS = [
  ["AE_01", 1, "agreement", false],
  ["AE_02", 3, "agreement", false],
  ["AE_05", 15, "agreement", false],
  ["AE_07", 24, "agreement", false],
  ["EM_04", 19, "agreement", false],
  ["MT_01", 32, "practice_years", false],
  ["MT_02", 33, "daily_practice", false],
  ["MT_03", 14, "agreement", true],
  ["MT_06", 37, "instruments", false],
  ["MT_07", 27, "agreement", true],
  ["PA_04", 12, "agreement", false],
  ["PA_08", 23, "agreement", true],
  ["SA_01", 4, "agreement", false],
  ["SA_02", 7, "agreement", false],
  ["SA_03", 10, "agreement", false],
  ["SA_04", 17, "agreement", true],
  ["SA_05", 25, "agreement", true],
  ["SA_06", 29, "agreement", false]
];
export const ITEM_IDS = Object.freeze(ITEM_DEFINITIONS.map(([id]) => id));

export function validateGmsiDataset(dataset, language) {
  if (!dataset || dataset.questionnaire_id !== QUESTIONNAIRE_ID ||
      dataset.questionnaire_version !== QUESTIONNAIRE_VERSION ||
      dataset.language !== language || !["en", "ko"].includes(language) ||
      !Array.isArray(dataset.items) || dataset.items.length !== ITEM_IDS.length) {
    throw new Error("GMSI_DATASET_INVALID");
  }
  for (const scale of ["agreement", "practice_years", "daily_practice", "instruments"]) {
    const labels = dataset.choices?.[scale];
    if (!Array.isArray(labels) || labels.length !== 7 || new Set(labels).size !== 7 ||
        labels.some(label => typeof label !== "string" || !label.trim())) {
      throw new Error("GMSI_CHOICES_INVALID");
    }
  }
  dataset.items.forEach((item, index) => {
    const [id, koreanNumber, scale, negative] = ITEM_DEFINITIONS[index];
    if (!item || item.id !== id || item.korean_item_number !== koreanNumber ||
        item.scale !== scale || item.negative !== negative ||
        typeof item.text !== "string" || !item.text.trim() ||
        typeof item.source_text !== "string" || !item.source_text.trim()) {
      throw new Error("GMSI_ITEM_INVALID");
    }
  });
  return dataset;
}

export async function loadGmsi(languageToggle) {
  const language = languageToggle === "eng" ? "en" : languageToggle === "kor" ? "ko" : null;
  if (!language) throw new Error("GMSI_LANGUAGE_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(new URL(`./data/${language}.json`, import.meta.url), {
      signal: controller.signal
    });
    if (!response.ok) throw new Error("GMSI_DATASET_HTTP_ERROR");
    return validateGmsiDataset(await response.json(), language);
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function decodeGmsiPage(dataset, pageNumber, response) {
  const pageCount = ITEM_IDS.length / PAGE_SIZE;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount ||
      !response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("GMSI_PAGE_INVALID");
  }
  const start = (pageNumber - 1) * PAGE_SIZE;
  const items = dataset.items.slice(start, start + PAGE_SIZE);
  if (Object.keys(response).length !== PAGE_SIZE) throw new Error("GMSI_RESPONSE_INCOMPLETE");
  return items.map((item, index) => {
    const raw = response[item.id];
    if (!Object.hasOwn(response, item.id) || !Number.isInteger(raw) || raw < 0 || raw > 6) {
      throw new Error("GMSI_RESPONSE_INVALID");
    }
    return {
      ...item,
      position: start + index + 1,
      response_index: raw,
      response_1_to_7: raw + 1,
      response_text: dataset.choices[item.scale][raw]
    };
  });
}

export function isGmsiRow(row) {
  return row.questionnaire_id === QUESTIONNAIRE_ID;
}

export function buildGmsiTrials({ dataset, plugin, condition }) {
  validateGmsiDataset(dataset, dataset?.language);
  if (typeof plugin !== "function") throw new Error("GMSI_PLUGIN_UNAVAILABLE");
  const text = dataset.language === "en" ? {
    title: "Music questionnaire",
    instructions: "Please select the most appropriate response for each statement.",
    page: "Page", next: "Next"
  } : {
    title: "음악 설문",
    instructions: "각 문항을 읽고 해당하는 응답을 선택해 주세요.",
    page: "페이지", next: "다음"
  };
  const pageCount = ITEM_IDS.length / PAGE_SIZE;
  let completedPages = 0;
  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const items = dataset.items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
    return {
      type: plugin,
      css_classes: ["gmsi-questionnaire"],
      preamble: `<h2>${text.title}</h2><p>${text.instructions}</p><p>${text.page} ${pageIndex + 1} / ${pageCount}</p>`,
      questions: items.map(item => ({
        name: item.id,
        prompt: escapeHtml(item.text),
        labels: dataset.choices[item.scale].map(escapeHtml),
        required: true,
        default_response: null
      })),
      randomize_question_order: false,
      autocomplete: false,
      button_label: text.next,
      data: {
        task: "musical_sophistication",
        phase: "questionnaire",
        condition,
        questionnaire_id: QUESTIONNAIRE_ID,
        questionnaire_version: QUESTIONNAIRE_VERSION,
        questionnaire_coding_version: CODING_VERSION,
        questionnaire_language: dataset.language,
        is_placeholder: false,
        gmsi_page: pageIndex + 1,
        gmsi_page_count: pageCount,
        item_ids: items.map(item => item.id),
        scale_labels: items.map(item => [...dataset.choices[item.scale]])
      },
      on_finish: function (data) {
        if (completedPages !== pageIndex) throw new Error("GMSI_PAGE_ORDER_INVALID");
        data.gmsi_answers = decodeGmsiPage(dataset, pageIndex + 1, data.response);
        completedPages++;
        if (completedPages === pageCount) data.gmsi_completed_at = new Date().toISOString();
      }
    };
  });
}
