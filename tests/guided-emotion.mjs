import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  parseEmotionVocabulary, loadEmotionVocabulary, loadGuidedEmotionStyles,
  mountGuidedEmotionInput
} from "../guided-emotion.js";
import { createEmotionDom } from "./emotion-dom.mjs";

const raw = Object.fromEntries(await Promise.all(["kor", "eng"].map(async language => [language,
  await readFile(new URL(`../${language === "kor" ? "korean" : "english"}_emotion_list.txt`, import.meta.url), "utf8")
])));

test("both external vocabularies match anywhere, sort by language, and resolve only complete expressions", () => {
  const korean = parseEmotionVocabulary(raw.kor, "kor");
  const english = parseEmotionVocabulary(raw.eng, "eng");
  assert.equal(korean.expressions.length, 988);
  assert.equal(english.expressions.length, 601);
  assert.deepEqual(korean.matches("가라앉"), ["가라앉은 기분", "가라앉음"]);
  assert.equal(korean.matches("가").length, 40);
  assert(korean.matches("가").includes("반가움"));
  assert(korean.matches("가").includes("머리가 아찔하고 붕 뜸"));
  assert.deepEqual(korean.matches("가").slice(0, 5), ["가뜬함", "가라앉은 기분", "가라앉음", "가련함", "가로막힘이 없는 듯함"]);
  assert.deepEqual(english.matches("PRIDE"), ["a surge of pride", "pride", "pride in country", "pride in family", "pride in self"]);
  assert.equal(english.resolve("  PRIDE IN   FAMILY  "), "pride in family");
  assert.equal(korean.resolve("가라앉"), undefined);
  assert.equal(korean.resolve("목록에 없는 응답"), undefined);
  assert.equal(korean.resolve("가라앉은  기분"), "가라앉은 기분");
  assert.deepEqual(korean.matches("  "), []);
  assert(!english.has("PRIDE"));
  assert(english.has("pride"));
});

test("neutral expressions are accepted and English partial/exact matches ignore capitalization", () => {
  const korean = parseEmotionVocabulary(raw.kor, "kor");
  const english = parseEmotionVocabulary(raw.eng, "eng");
  assert(korean.matches("중").includes("중립"));
  assert.equal(korean.resolve("중립"), "중립");
  for (const query of ["neu", "NEU", "nEu", "eUtRa"]) {
    assert.deepEqual(english.matches(query), ["neutral"]);
  }
  for (const value of ["neutral", "NEUTRAL", "NeUtRaL"]) {
    assert.equal(english.resolve(value), "neutral");
  }
});

test("search ignores whitespace in either language, including matches across word boundaries", () => {
  const korean = parseEmotionVocabulary(raw.kor, "kor");
  const english = parseEmotionVocabulary(raw.eng, "eng");
  for (const query of ["가라앉은기분", "은기", "가 라 앉 은 기 분", "은\t기"]) {
    assert(korean.matches(query).includes("가라앉은 기분"), query);
  }
  for (const query of ["prideinfamily", "PRIDEINFAMILY", "PrIdE InFaMiLy", "PRIDE IN FAMILY"]) {
    assert.deepEqual(english.matches(query), ["pride in family"]);
  }
  assert(english.matches("eInFa").includes("pride in family"));
  assert.deepEqual(korean.matches(" \t "), []);
  assert.deepEqual(english.matches(" \t "), []);
});

test("missing, blank, duplicate, corrupted and ambiguous vocabularies fail explicitly", () => {
  for (const language of ["kor", "eng"]) {
    const parts = raw[language].split(",").map(word => word.trim());
    for (const invalid of ["", raw[language] + ",", parts.slice(1).join(","),
      [parts[0], ...parts.slice(0, -1)].join(","),
      ["", ...parts.slice(1)].join(","), ["bad\ufffdword", ...parts.slice(1)].join(",")]) {
      assert.throws(() => parseEmotionVocabulary(invalid, language), /EMOTION_VOCABULARY_INVALID/);
    }
  }
  const english = raw.eng.split(",").map(word => word.trim());
  english[1] = english[0].toUpperCase();
  assert.throws(() => parseEmotionVocabulary(english.join(","), "eng"), /VOCABULARY_INVALID/);
  assert.throws(() => parseEmotionVocabulary(raw.kor, "fr"), /LANGUAGE_INVALID/);
});

test("loader requests only the configured text file and rejects every unsuccessful load", async t => {
  for (const language of ["kor", "eng"]) {
    let requested;
    t.mock.method(globalThis, "fetch", async (url, options) => {
      requested = url.pathname;
      assert.equal(options.cache, "no-store");
      assert(options.signal instanceof AbortSignal);
      return {ok: true, text: async () => raw[language]};
    });
    const vocabulary = await loadEmotionVocabulary(language);
    assert.equal(vocabulary.language, language);
    assert(requested.endsWith(`/${language === "kor" ? "korean" : "english"}_emotion_list.txt`));
    t.mock.restoreAll();
  }
  for (const response of [{ok: false}, {ok: true, text: async () => ""},
    {ok: true, text: async () => {throw new Error("TEST_BODY_FAILURE");}}]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(loadEmotionVocabulary("kor"));
    t.mock.restoreAll();
  }
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {calls++; throw new Error("TEST_NETWORK_FAILURE");});
  await assert.rejects(loadEmotionVocabulary("kor"), /TEST_NETWORK_FAILURE/);
  assert.equal(calls, 1);
  await assert.rejects(loadEmotionVocabulary("fr"), /LANGUAGE_INVALID/);
  assert.equal(calls, 1);
});

test("vocabulary fetch and body reads both time out without switching lists", async t => {
  for (const body of [false, true]) await t.test(body ? "body" : "headers", async t => {
    t.mock.timers.enable({apis: ["setTimeout"]});
    t.mock.method(globalThis, "fetch", async (url, {signal}) => {
      const pending = () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
      return body ? {ok: true, text: pending} : pending();
    });
    const loading = loadEmotionVocabulary("kor");
    const rejected = assert.rejects(loading, {name: "AbortError"});
    await Promise.resolve();
    t.mock.timers.tick(30000);
    await rejected;
  });
});

test("response styles must confirm loading; missing styles and timeout reject", async t => {
  for (const success of [true, false]) {
    const {document} = createEmotionDom();
    document.head.appendChild = link => {queueMicrotask(() => success ? link.onload() : link.onerror());};
    if (success) await loadGuidedEmotionStyles(document);
    else await assert.rejects(loadGuidedEmotionStyles(document), /STYLE_LOAD_FAILED/);
  }
  const {document} = createEmotionDom();
  t.mock.timers.enable({apis: ["setTimeout"]});
  const loading = loadGuidedEmotionStyles(document);
  const rejected = assert.rejects(loading, /STYLE_TIMEOUT/);
  t.mock.timers.tick(30000);
  await rejected;
  assert.equal(document.head.children.length, 0);
});

function mount(vocabulary) {
  const dom = createEmotionDom();
  const selected = [];
  const controller = mountGuidedEmotionInput({display: dom.display, vocabulary,
    onSelect: word => selected.push(word), onInput() {}});
  const fill = query => {dom.input.value = query; dom.input.fire("input");};
  return {...dom, controller, selected, fill, list: dom.node("#emotion-options"), menu: dom.node("#emotion-suggestions")};
}

test("spaceless queries highlight the original text and select the original expression", () => {
  for (const [language, query, expression, highlight] of [
    ["kor", "은기", "가라앉은 기분", "은 기"],
    ["kor", "가라앉은기분", "가라앉은 기분", "가라앉은 기분"],
    ["eng", "eInFa", "pride in family", "e in fa"],
    ["eng", "PRIDEINFAMILY", "pride in family", "pride in family"]
  ]) {
    const ui = mount(parseEmotionVocabulary(raw[language], language));
    ui.fill(query);
    const option = ui.list.children.find(button => button.textContent === expression);
    assert(option, query);
    assert.equal(option.children.find(child => child.classList.contains("emotion-match")).textContent, highlight);
    option.click();
    assert.deepEqual(ui.selected, [expression]);
    ui.controller.destroy();
  }
});

test("five results stay collapsed; sixth overflow opens the complete sorted, scrollable list", () => {
  const entries = [
    ...Array.from({length: 5}, (_, i) => `five ${i}`),
    ...Array.from({length: 6}, (_, i) => `six ${i}`),
    ...Array.from({length: 11}, (_, i) => `eleven ${String(i).padStart(2, "0")}`),
    ...Array.from({length: 579}, (_, i) => `spare ${i}`)
  ];
  const ui = mount(parseEmotionVocabulary(entries.join(","), "eng"));
  assert(ui.menu.hidden);
  ui.fill("five");
  assert.equal(ui.list.children.length, 5);
  ui.fill("six");
  assert.equal(ui.list.children.length, 6);
  assert.equal(ui.list.children[5].textContent, "...");
  ui.list.children[5].click();
  assert(!ui.menu.hidden);
  assert.equal(ui.list.children.length, 6);
  assert(ui.list.classList.contains("is-expanded"));
  assert.deepEqual(ui.list.children.map(option => option.textContent), entries.slice(5, 11));
  assert.deepEqual(ui.selected, []);
  ui.fill("eleven");
  assert(!ui.list.classList.contains("is-expanded"));
  ui.list.children[5].click();
  assert(!ui.menu.hidden);
  assert.equal(ui.list.children.length, 11);
  assert(ui.list.classList.contains("is-expanded"));
  ui.list.children[10].click();
  assert.deepEqual(ui.selected, ["eleven 10"]);
  ui.fill("unknown");
  assert.equal(ui.node("#emotion-no-matches").hidden, false);
  ui.fill("");
  assert(ui.menu.hidden);
  ui.controller.destroy();
});

test("clicking overflow keeps the full matching list open in both languages until an outside click", () => {
  for (const [language, query] of [["kor", "가"], ["eng", "FEELING"]]) {
    const vocabulary = parseEmotionVocabulary(raw[language], language);
    const ui = mount(vocabulary);
    ui.input.focus();
    ui.fill(query);
    const more = ui.list.children[5];
    assert.equal(more.textContent, "...");
    more.click();
    assert(!ui.menu.hidden, `${language}: expansion must remain visible after the click bubbles`);
    assert.equal(ui.input.attributes["aria-expanded"], "true");
    assert.equal(ui.input.value, query);
    assert(ui.list.classList.contains("is-expanded"));
    assert.deepEqual(ui.list.children.map(option => option.textContent), vocabulary.matches(query));
    assert.deepEqual(ui.selected, []);
    ui.node("#outside-dropdown").click();
    assert(ui.menu.hidden);
    assert.equal(ui.input.attributes["aria-expanded"], "false");
    ui.controller.destroy();
  }
});

test("keyboard selection, overflow, IME, escape and cleanup never implicitly accept a partial match", () => {
  const ui = mount(parseEmotionVocabulary(raw.kor, "kor"));
  ui.fill("가");
  ui.input.fire("keydown", {key: "Enter"});
  assert.deepEqual(ui.selected, ["가"]); // Caller must validate, without substituting the first suggestion.
  ui.selected.length = 0;
  ui.input.fire("compositionstart");
  ui.input.fire("keydown", {key: "Enter", isComposing: true});
  assert.deepEqual(ui.selected, []);
  ui.input.fire("compositionend");
  for (let i = 0; i < 6; i++) ui.input.fire("keydown", {key: "ArrowDown"});
  ui.input.fire("keydown", {key: "Enter"});
  assert(ui.list.classList.contains("is-expanded"));
  assert.deepEqual(ui.selected, []);
  ui.input.fire("keydown", {key: "ArrowUp"});
  ui.input.fire("keydown", {key: "Enter"});
  assert.deepEqual(ui.selected, ["흥미가 생기는 혼란"]);
  assert(ui.list.scrollTop > 0);
  ui.input.fire("keydown", {key: "Escape"});
  assert(ui.menu.hidden);
  ui.controller.destroy();
  ui.input.fire("input");
  ui.input.fire("keydown", {key: "Enter"});
  assert(ui.menu.hidden);
  assert.equal(ui.selected.length, 1);
  assert.equal(ui.input.attributes["aria-expanded"], "false");
  assert.equal(ui.input.attributes["aria-activedescendant"], undefined);
});

test("pointer selection commits Korean composition before accepting the chosen expression", () => {
  const ui = mount(parseEmotionVocabulary(raw.kor, "kor"));
  ui.fill("가라앉");
  ui.input.fire("compositionstart");
  let blurred = false;
  ui.input.blur = () => { blurred = true; ui.input.fire("compositionend"); };
  ui.list.children[1].click();
  assert(blurred);
  assert(!ui.controller.isComposing());
  assert.deepEqual(ui.selected, ["가라앉음"]);
  ui.controller.destroy();
});
