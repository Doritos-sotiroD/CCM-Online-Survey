import { DOMAINS, SCORING_VERSION, scoreBigFive } from "./scoring.js";

export const QUESTIONNAIRE_ID = "ipip_neo_120";
export const QUESTIONNAIRE_VERSION = "ipip_neo_120_v1";
export const SOURCE_COMMIT = "e8f3caca49edafb9bc6b927eff7fbc1264312c24";
export const PAGE_SIZE = 10;

export function validateBigFiveDataset(dataset, language) {
  if (!dataset || dataset.questionnaire_id !== QUESTIONNAIRE_ID ||
      dataset.source_commit !== SOURCE_COMMIT || dataset.language !== language ||
      !["en", "ko"].includes(language) ||
      !Array.isArray(dataset.items) || dataset.items.length !== 120) {
    throw new Error("BIGFIVE_DATASET_INVALID");
  }
  for (const key of ["plus", "minus"]) {
    const choices = dataset.choices?.[key];
    if (!Array.isArray(choices) || choices.length !== 5 || choices.some((choice, index) =>
      typeof choice?.text !== "string" || !choice.text.trim() ||
      choice.score !== (key === "plus" ? index + 1 : 5 - index) ||
      choice.text !== dataset.choices.plus[index].text
    )) throw new Error("BIGFIVE_CHOICES_INVALID");
  }
  const ids = new Set();
  const counts = {};
  for (const item of dataset.items) {
    if (!item || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(item.id) ||
        ids.has(item.id) || typeof item.text !== "string" || !item.text.trim() ||
        !["plus", "minus"].includes(item.keyed) || !DOMAINS.includes(item.domain) ||
        !Number.isInteger(item.facet) || item.facet < 1 || item.facet > 6) {
      throw new Error("BIGFIVE_ITEM_INVALID");
    }
    ids.add(item.id);
    const key = `${item.domain}${item.facet}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const domain of DOMAINS) {
    for (let facet = 1; facet <= 6; facet++) {
      if (counts[`${domain}${facet}`] !== 4) throw new Error("BIGFIVE_ITEMS_INCOMPLETE");
    }
  }
  return dataset;
}

export async function loadBigFive(languageToggle) {
  const language = languageToggle === "eng" ? "en" : languageToggle === "kor" ? "ko" : null;
  if (!language) throw new Error("BIGFIVE_LANGUAGE_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(new URL(`./data/${language}.json`, import.meta.url), {
      signal: controller.signal
    });
    if (!response.ok) throw new Error("BIGFIVE_DATASET_HTTP_ERROR");
    return validateBigFiveDataset(await response.json(), language);
  } finally {
    clearTimeout(timeout);
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function decodeBigFivePage(dataset, pageNumber, response) {
  const start = (pageNumber - 1) * PAGE_SIZE;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || start >= dataset.items.length ||
      !response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("BIGFIVE_PAGE_INVALID");
  }
  const items = dataset.items.slice(start, start + PAGE_SIZE);
  if (Object.keys(response).length !== items.length) throw new Error("BIGFIVE_RESPONSE_INCOMPLETE");
  return items.map((item, index) => {
    const raw = response[item.id];
    if (!Number.isInteger(raw) || raw < 0 || raw > 4) throw new Error("BIGFIVE_RESPONSE_INVALID");
    const choice = dataset.choices[item.keyed][raw];
    return {
      ...item,
      position: start + index + 1,
      response_index: raw,
      response_1_to_5: raw + 1,
      response_text: choice.text,
      score: choice.score
    };
  });
}

export function isBigFiveRow(row) {
  return row.questionnaire_id === QUESTIONNAIRE_ID;
}

export function buildBigFiveTrials({ dataset, plugin, condition }) {
  validateBigFiveDataset(dataset, dataset?.language);
  if (typeof plugin !== "function") throw new Error("BIGFIVE_PLUGIN_UNAVAILABLE");
  const text = dataset.language === "en" ? {
    title: "Personality questionnaire",
    instructions: "Please answer each statement based on how you generally describe yourself.",
    page: "Page", next: "Next"
  } : {
    title: "성격 설문",
    instructions: "평소의 자신을 기준으로 각 문항에 응답해 주세요.",
    page: "페이지", next: "다음"
  };
  const answers = [];
  let completedPages = 0;
  const pageCount = dataset.items.length / PAGE_SIZE;
  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const items = dataset.items.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);
    return {
      type: plugin,
      css_classes: ["bigfive-questionnaire"],
      preamble: `<h2>${text.title}</h2><p>${text.instructions}</p><p>${text.page} ${pageIndex + 1} / ${pageCount}</p>`,
      questions: items.map(item => ({
        name: item.id,
        prompt: escapeHtml(item.text),
        labels: dataset.choices[item.keyed].map(choice => escapeHtml(choice.text)),
        required: true,
        default_response: null
      })),
      randomize_question_order: false,
      autocomplete: false,
      button_label: text.next,
      data: {
        task: "personality_traits",
        phase: "questionnaire",
        condition,
        questionnaire_id: QUESTIONNAIRE_ID,
        questionnaire_version: QUESTIONNAIRE_VERSION,
        questionnaire_source_commit: SOURCE_COMMIT,
        questionnaire_scoring_version: SCORING_VERSION,
        questionnaire_language: dataset.language,
        is_placeholder: false,
        bigfive_page: pageIndex + 1,
        bigfive_page_count: pageCount,
        item_ids: items.map(item => item.id),
        scale_labels: dataset.choices.plus.map(choice => choice.text)
      },
      on_finish: function (data) {
        if (completedPages !== pageIndex) throw new Error("BIGFIVE_PAGE_ORDER_INVALID");
        data.bigfive_answers = decodeBigFivePage(dataset, pageIndex + 1, data.response);
        answers.push(...data.bigfive_answers);
        completedPages++;
        if (completedPages === pageCount) {
          data.bigfive_result = scoreBigFive(answers);
          data.bigfive_completed_at = new Date().toISOString();
        }
      }
    };
  });
}
