import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { crc32 } from "node:zlib";
import {
  buildBigFiveTrials, decodeBigFivePage, loadBigFive, validateBigFiveDataset
} from "../questionnaires/bigfive/questionnaire.js";
import { scoreBigFive } from "../questionnaires/bigfive/scoring.js";
import { createBigFiveCsv } from "../questionnaires/bigfive/export.js";
import { buildGmsiTrials } from "../questionnaires/gmsi/questionnaire.js";
import { createGmsiCsv } from "../questionnaires/gmsi/export.js";
import { createExperimentCsv, createProceduralCsv } from "../exports/study.js";
import { createResultsZip } from "../exports/zip.js";
import { musicRows as experimentRows, practiceRows } from "./study-fixtures.mjs";
import { parseEmotionVocabulary, mountGuidedEmotionInput, normalizeEmotion, emotionResponseText } from "../guided-emotion.js";
import { createEmotionDom } from "./emotion-dom.mjs";

const datasets = Object.fromEntries(await Promise.all(["en", "ko"].map(async language => [
  language, JSON.parse(await readFile(new URL(`../questionnaires/bigfive/data/${language}.json`, import.meta.url), "utf8"))
])));
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const emotionVocabularies = Object.fromEntries(await Promise.all(["kor", "eng"].map(async language => [
  language, parseEmotionVocabulary(await readFile(new URL(`../${language === "kor" ? "korean" : "english"}_emotion_list.txt`, import.meta.url), "utf8"), language)
])));
const gmsiDatasets = Object.fromEntries(await Promise.all(["en", "ko"].map(async language => [
  language, JSON.parse(await readFile(new URL(`../questionnaires/gmsi/data/${language}.json`, import.meta.url), "utf8"))
])));
const sessionId = "TEST_BIGFIVE_ONLY";
const metadata = {
  session_id: sessionId, experiment_version: "ccm_draft_07", condition: "condition_1",
  sessions_completed: 0, verification_skip_sessions: true, completed_at: "2026-10-11T00:00:00.000Z"
};

test("direct-file startup explains how to open HTTP even when module imports are blocked", () => {
  const guard = html.match(/<script id="local-preview-check">([\s\S]*?)<\/script>/)[1];
  for (const protocol of ["file:", "http:", "https:"]) {
    const document = {body:{innerHTML:""}};
    vm.runInNewContext(guard, {location:{protocol},document});
    if (protocol === "file:") {
      assert(document.body.innerHTML.includes('href="http://127.0.0.1:8765/"'));
      assert(document.body.innerHTML.includes("python -m http.server"));
    } else {
      assert.equal(document.body.innerHTML, "");
    }
  }
});

function startupHarness(language, bodyReady = true) {
  const listeners = new Map();
  const status = {textContent:""};
  const state = {bodyReady, removed:false};
  const document = {
    documentElement:{lang:"ko"}, body:{textContent:""},
    getElementById(id) {
      if (!state.bodyReady) return null;
      return id === "survey-startup-status" ? status : {remove(){state.removed=true;}};
    },
    addEventListener(name, handler){listeners.set(name,handler);}
  };
  const window = {
    addEventListener(name, handler){listeners.set(name,handler);},
    removeEventListener(name){listeners.delete(name);}
  };
  const source = html.match(/<script id="survey-startup-guard">([\s\S]*?)<\/script>/)[1]
    .replace('const language = "kor";', `const language = "${language}";`);
  const context = {document,window,location:{protocol:"https:"}};
  vm.runInNewContext(source + "\nglobalThis.startup = surveyStartup;",context);
  return {startup:context.startup,status,state,listeners,document};
}

test("startup shows the exact loading text in both languages before deferred dependencies execute", () => {
  for (const language of ["kor","eng"]) {
    const {startup,status,document} = startupHarness(language);
    startup.render();
    assert.equal(status.textContent,language === "kor" ? "실험이 로딩중입니다" : "The experiment is being loaded");
    assert.equal(document.documentElement.lang,language === "kor" ? "ko" : "en");
  }
  for (const script of html.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*>/g)) assert.match(script[0],/\bdefer\b/);
  assert(html.indexOf('id="survey-startup-guard"') < html.indexOf('src="https://unpkg.com/'));
  assert.match(html, /media="print" onload="this.media='all'; surveyStartup.stylesLoaded\(\)"/);
});

test("resource/module/initialization failures show a contactable startup error, including failures before body parsing", async () => {
  for (const language of ["kor","eng"]) for (const event of ["error","unhandledrejection"]) {
    const {startup,status,state,listeners} = startupHarness(language,false);
    listeners.get(event)({message:"PRIVATE_ERROR_DETAILS"});
    state.bodyReady = true;
    listeners.get("DOMContentLoaded")();
    assert.equal(startup.failed,true);
    assert(status.textContent.includes("ben701@kaist.ac.kr"));
    assert(!status.textContent.includes("PRIVATE_ERROR_DETAILS"));
    assert(!status.textContent.includes("로딩중") && !status.textContent.includes("being loaded"));
    await assert.rejects(startup.stylesReady,/SURVEY_STARTUP_FAILED/);
    assert.throws(()=>startup.complete(),/SURVEY_STARTUP_FAILED/);
  }
});

test("startup waits for stylesheet readiness and stops intercepting errors once the first trial starts", async () => {
  const {startup,status,state,listeners} = startupHarness("eng");
  let ready=false;
  startup.stylesReady.then(()=>{ready=true;});
  await Promise.resolve();
  assert.equal(ready,false);
  startup.stylesLoaded();
  await startup.stylesReady;
  assert.equal(ready,true);
  startup.complete();
  assert.equal(state.removed,true);
  assert.equal(listeners.has("error"),false);
  assert.equal(listeners.has("unhandledrejection"),false);
  startup.fail("TEST_LATE_FAILURE");
  assert.equal(startup.failed,false);
  assert(!status.textContent.includes("TEST_LATE_FAILURE"));
});

// Independent ZIP reader: validate the directory, each payload, and CRCs using Node's zlib.
async function readResultsZip(blob) {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const footer = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(footer),0x06054b50);
  const count = bytes.readUInt16LE(footer + 10);
  let position = bytes.readUInt32LE(footer + 16);
  assert.equal(position + bytes.readUInt32LE(footer + 12),footer);
  const files = [];
  for (let index=0;index<count;index++) {
    assert.equal(bytes.readUInt32LE(position),0x02014b50);
    assert.equal(bytes.readUInt16LE(position+10),0);
    assert.equal(bytes.readUInt16LE(position+8),0x0800);
    const length = bytes.readUInt32LE(position+24);
    const nameLength = bytes.readUInt16LE(position+28);
    const filename = bytes.subarray(position+46,position+46+nameLength).toString("utf8");
    const local = bytes.readUInt32LE(position+42);
    assert.equal(bytes.readUInt32LE(local),0x04034b50);
    const start = local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    const payload = bytes.subarray(start,start+length);
    assert.equal(bytes.subarray(local+30,local+30+nameLength).toString("utf8"),filename);
    assert.equal(bytes.readUInt32LE(local+22),length);
    assert.equal(bytes.readUInt32LE(local+14),crc32(payload));
    assert.equal(bytes.readUInt32LE(position+16),crc32(payload));
    files.push({filename,data:payload.toString("utf8")});
    position += 46+nameLength+bytes.readUInt16LE(position+30)+bytes.readUInt16LE(position+32);
  }
  assert.equal(position,footer);
  return files;
}

test("ZIP preserves exact Unicode/CSV/JSON bytes and rejects invalid or duplicate filenames", async () => {
  const files = [
    {filename:"TEST_results.csv",data:'"감정","quote""comma,\r\nline"\r\n'},
    {filename:"TEST_raw.json",data:JSON.stringify({raw:"한글 🎵",number:"01012345678"})},
    {filename:"TEST_empty.csv",data:""}
  ];
  const before = structuredClone(files);
  const zip = createResultsZip(files);
  assert.equal(zip.type,"application/zip");
  assert.deepEqual(await readResultsZip(zip),files);
  assert.deepEqual(files,before);
  for (const invalid of [[],[{filename:"../escape.csv",data:"x"}],[files[0],files[0]],[{filename:"TEST.csv",data:null}]]) {
    assert.throws(()=>createResultsZip(invalid),/RESULTS_ZIP_/);
  }
});

function completedPages(dataset, condition = "condition_1", raw = index => index % 5) {
  return buildBigFiveTrials({ dataset, plugin: function SurveyLikert() {}, condition }).map((trial, index) => {
    const row = {
      ...structuredClone(trial.data), session_id: sessionId, trial_type: "survey-likert",
      response: Object.fromEntries(trial.questions.map((question, offset) => [question.name, raw(index * 10 + offset)])),
      rt: 1000 + index, time_elapsed: 2000 + index, question_order: Array.from({length:10}, (_, i) => i)
    };
    trial.on_finish(row);
    return row;
  });
}

// Independent CSV parser, including quoted JSON, Unicode, commas, quotes/newlines.
function parseCsv(text) {
  const result = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); result.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  assert.equal(quoted, false);
  if (row.length || cell) { row.push(cell); result.push(row); }
  return result;
}

test("both languages retain the exact pinned source items/choices", () => {
  // Fingerprints computed from the fetched upstream objects, before local writing.
  const hashes = {
    en: "218f968a2562d571b7d3138a787fa5687f94026b6ba618ad3c48091e3cb61382",
    ko: "a72f8906f6f4a3eb70b1866823a725e681321d810a6b4bb3406412137fd3dceb"
  };
  for (const [language, dataset] of Object.entries(datasets)) {
    assert.equal(validateBigFiveDataset(dataset, language), dataset);
    assert.equal(createHash("sha256").update(JSON.stringify({items:dataset.items, choices:dataset.choices})).digest("hex"), hashes[language]);
  }
  assert.deepEqual(datasets.en.items.map(({id,keyed,domain,facet}) => ({id,keyed,domain,facet})),
    datasets.ko.items.map(({id,keyed,domain,facet}) => ({id,keyed,domain,facet})));
  const bad = structuredClone(datasets.ko);
  bad.items[1].id = bad.items[0].id;
  assert.throws(() => validateBigFiveDataset(bad, "ko"), /BIGFIVE_ITEM_INVALID/);
  assert.throws(() => validateBigFiveDataset(datasets.en, "ko"), /BIGFIVE_DATASET_INVALID/);
});

test("language loader has no translation/data fallback", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  try {
    globalThis.fetch = async url => {
      urls.push(String(url));
      return {ok:true, json:async () => structuredClone(String(url).endsWith("/ko.json") ? datasets.ko : datasets.en)};
    };
    assert.equal((await loadBigFive("eng")).language, "en");
    assert.equal((await loadBigFive("kor")).language, "ko");
    assert.equal(urls.length, 2);
    await assert.rejects(loadBigFive("unknown"), /BIGFIVE_LANGUAGE_INVALID/);
    await assert.rejects(loadBigFive("__proto__"), /BIGFIVE_LANGUAGE_INVALID/);
    globalThis.fetch = async () => ({ok:false});
    await assert.rejects(loadBigFive("kor"), /BIGFIVE_DATASET_HTTP_ERROR/);
    globalThis.fetch = async () => ({ok:true, json:async () => datasets.en});
    await assert.rejects(loadBigFive("kor"), /BIGFIVE_DATASET_INVALID/);
  } finally { globalThis.fetch = originalFetch; }
});

test("120 required items, fixed order, no defaults, raw answers retained in both languages", () => {
  for (const dataset of Object.values(datasets)) {
    const trials = buildBigFiveTrials({dataset,plugin:function SurveyLikert(){},condition:"condition_2"});
    assert.equal(trials.length, 12);
    assert.deepEqual(trials.flatMap(t => t.questions.map(q => q.name)), dataset.items.map(i => i.id));
    for (const trial of trials) {
      assert.equal(trial.randomize_question_order, false);
      assert.equal(trial.questions.length, 10);
      for (const question of trial.questions) {
        assert.equal(question.required, true);
        assert.equal(question.default_response, null);
        assert.deepEqual(question.labels, dataset.choices.plus.map(c => c.text));
      }
    }
    const rows = completedPages(dataset, "condition_2");
    const answers = rows.flatMap(r => r.bigfive_answers);
    assert.equal(answers.length, 120);
    for (let i = 0; i < 120; i++) {
      const answer = answers[i];
      assert.equal(rows[Math.floor(i / 10)].response[answer.id], i % 5);
      assert.equal(answer.response_1_to_5, i % 5 + 1);
      assert.equal(answer.score, dataset.items[i].keyed === "plus" ? i % 5 + 1 : 5 - i % 5);
      assert.equal(answer.response_text, dataset.choices.plus[i % 5].text);
    }
    assert.equal(rows.slice(0, -1).some(row => "bigfive_result" in row), false);
    assert.deepEqual(rows.at(-1).bigfive_result, scoreBigFive(answers));
  }
  const firstResponse = Object.fromEntries(datasets.en.items.slice(0,10).map(item => [item.id, 0]));
  assert.throws(() => decodeBigFivePage(datasets.en, 1, {...firstResponse, [datasets.en.items[0].id]:null}), /RESPONSE_INVALID/);
  assert.throws(() => decodeBigFivePage(datasets.en, 1, {}), /RESPONSE_INCOMPLETE/);
  assert.throws(() => decodeBigFivePage(datasets.en, 1, {...firstResponse, extra:0}), /RESPONSE_INCOMPLETE/);
});

test("source reverse keys and pinned scoring thresholds produce expected factor/facet totals", () => {
  // Source has plus counts N=17,E=18,O=12,A=7,C=11, out of 24 each.
  const expectedAtFirstChoice = {N:52, E:48, O:72, A:92, C:76};
  for (const raw of [0, 4]) {
    const result = completedPages(datasets.en, "condition_1", () => raw).at(-1).bigfive_result;
    for (const domain of ["N","E","O","A","C"]) {
      assert.equal(result[domain].score, raw === 0 ? expectedAtFirstChoice[domain] : 144 - expectedAtFirstChoice[domain]);
      assert.equal(result[domain].count, 24);
      assert.equal(Object.keys(result[domain].facet).length, 6);
      for (const facet of Object.values(result[domain].facet)) assert.equal(facet.count, 4);
    }
  }
  const answers = completedPages(datasets.en).flatMap(row => row.bigfive_answers);
  for (const [score, classification] of [[2,"low"],[3,"neutral"],[4,"high"]]) {
    const result = scoreBigFive(answers.map(answer => ({...answer, score})));
    for (const domain of Object.values(result)) {
      assert.equal(domain.score, score * 24);
      assert.equal(domain.result, classification);
      for (const facet of Object.values(domain.facet)) {
        assert.equal(facet.score, score * 4);
        assert.equal(facet.result, classification);
      }
    }
  }
  assert.throws(() => scoreBigFive(answers.slice(1)), /INCOMPLETE/);
  assert.throws(() => scoreBigFive([answers[1], ...answers.slice(1)]), /INVALID/);
});

test("separate CSV joins by session_id and round-trips every raw/derived response and result", () => {
  for (const dataset of Object.values(datasets)) {
    const pages = completedPages(dataset);
    const original = structuredClone(pages);
    const parsed = parseCsv(createBigFiveCsv(pages, dataset, metadata));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].length, parsed[1].length);
    assert.equal(new Set(parsed[0]).size, parsed[0].length);
    const record = Object.fromEntries(parsed[0].map((header, index) => [header, parsed[1][index]]));
    assert.equal(record.session_id, sessionId);
    assert.equal(record.trial_type, "survey-likert");
    const answers = pages.flatMap(row => row.bigfive_answers);
    assert.deepEqual(JSON.parse(record.item_responses), answers);
    assert.deepEqual(JSON.parse(record.page_responses).map(p => p.response), pages.map(p => p.response));
    for (const answer of answers) {
      for (const key of ["response_index", "response_1_to_5", "score"]) {
        assert.equal(Number(record[`item_${answer.id}_${key}`]), answer[key]);
      }
    }
    for (const [name, domain] of Object.entries(pages.at(-1).bigfive_result)) {
      for (const field of ["score","count","result"]) {
        assert.equal(record[`${name}_${field}`], String(domain[field]));
        for (let facet = 1; facet <= 6; facet++) assert.equal(record[`${name}${facet}_${field}`], String(domain.facet[facet][field]));
      }
    }
    assert.deepEqual(pages, original);
    assert.throws(() => createBigFiveCsv(pages.slice(1), dataset, metadata), /INCOMPLETE/);
    const bad = structuredClone(pages);
    bad[0].response[dataset.items[0].id] = 4;
    assert.throws(() => createBigFiveCsv(bad, dataset, metadata), /MISMATCH/);
    const badResult = structuredClone(pages);
    badResult.at(-1).bigfive_result.N.score++;
    assert.throws(() => createBigFiveCsv(badResult, dataset, metadata), /RESULT_INVALID/);
  }
});

// Minimal jsPsych/DOM boundary for timeline and persistence control-flow checks.
// Network calls are always intercepted; no test can send production data.
class DataCollection {
  constructor(rows) { this.rows = rows; }
  values() { return this.rows; }
  readOnly() { return new DataCollection(structuredClone(this.rows)); }
  filterCustom(predicate) { return new DataCollection(this.rows.filter(predicate)); }
  addToAll(fields) { for (const row of this.rows) Object.assign(row, fields); }
  csv() {
    const headers = [...new Set(this.rows.flatMap(row => Object.keys(row)))];
    const cell = value => '"' + (value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/"/g, '""') + '"';
    return headers.map(cell).join(",") + "\r\n" + this.rows.map(row => headers.map(h => cell(row[h])).join(",")).join("\r\n") + "\r\n";
  }
}
function makeApp({language="kor", condition=0, skip=true, upload, archive=createResultsZip,
  poolSize=200, sample=(pool,count)=>pool.slice(0,count), shuffle=array=>[...array],
  loadEmotions=async language => emotionVocabularies[language], loadEmotionStyles=async () => {},
  getAudioPlayer=async () => {throw new Error("TEST_UNEXPECTED_AUDIO_REQUEST");},
  load=async language => structuredClone(datasets[language === "eng" ? "en" : "ko"]),
  loadMusic=async language => structuredClone(gmsiDatasets[language === "eng" ? "en" : "ko"])} = {}) {
  const nodes = Object.fromEntries(["save-status","save-reference","save-retry","save-download","save-recovery-help"].map(id => [id, {
    textContent:"", hidden:true, disabled:false, listeners:{}, addEventListener(name, handler){this.listeners[name]=handler;}
  }]));
  const display = {innerHTML:"", textContent:"", dataset:{}, querySelector(selector){assert(selector.slice(1) in nodes);return nodes[selector.slice(1)];}};
  const state = {rows:[], properties:{}, requests:[], timers:new Map(), nextTimer:0, display, nodes, metadataRequests:0, samplingRequests:[], runs:0, now:0, archives:[], revokedUrls:[], emotionLanguages:[], emotionStyleRequests:0};
  const jsPsych = {
    randomization: {randomID:() => sessionId, sampleWithoutReplacement:(pool, count) => {state.samplingRequests.push({size:pool.length,count});return sample(pool,count);}, shuffle},
    data: {addProperties(fields){Object.assign(state.properties,fields);for (const row of state.rows) Object.assign(row,fields);}, get:() => new DataCollection(state.rows)},
    getDisplayElement:() => state.display, run:timeline => {state.timeline=timeline;state.runs++;},
    pluginAPI:{getAudioPlayer,audioContext() {}},
    timelineVariable:name => ({timelineVariable:name}),
    evaluateTimelineVariable:name => {assert.equal(name,"audioFile");return state.currentAudioFile;},
    abortExperiment:message => {state.aborted=message;}
  };
  const context = {
    initJsPsych:options => {state.options=options;return jsPsych;},
    loadBigFive:load, buildBigFiveTrials, createBigFiveCsv,
    loadGmsi:loadMusic, buildGmsiTrials, createGmsiCsv,
    createExperimentCsv, createProceduralCsv, performance:{now:()=>state.now},
    createResultsZip:archive,
    loadEmotionVocabulary:language => {state.emotionLanguages.push(language);return loadEmotions(language);},
    loadGuidedEmotionStyles:document => {state.emotionStyleRequests++;return loadEmotionStyles(document);},
    mountGuidedEmotionInput, normalizeEmotion, emotionResponseText,
    URL:{createObjectURL(blob){state.archives.push(blob);return `blob:TEST_${state.archives.length}`;},revokeObjectURL(url){state.revokedUrls.push(url);}},
    surveyStartup:{language,failed:false,stylesReady:Promise.resolve(),complete(){},fail(id){context.document.body.textContent="STARTUP_FAILED " + id;}},
    AbortController, TextEncoder, Date, location:{protocol:"http:"}, document:{body:{}}, console,
    setTimeout:(callback, delay) => {const id=++state.nextTimer;state.timers.set(id,{callback,delay});return id;},
    clearTimeout:id => state.timers.delete(id),
    fetch:async (url, options) => {
      if (url === "metadata.csv") {
        state.metadataRequests++;
        return {ok:true,text:async () => "clip_filename,work_id\n" + Array.from({length:poolSize},(_, i) => `${String((i+1)*20).padStart(4,"0")}.mp3,WORK_${(i+1)*20}`).join("\n")};
      }
      if (url === "https://pipe.jspsych.org/api/condition/") return {status:200,json:async () => ({condition})};
      assert.equal(url, "https://pipe.jspsych.org/api/data/");
      state.requests.push({body:options.body, parsed:JSON.parse(options.body)});
      assert.equal(options.credentials,"omit");
      return upload ? upload(state.requests.length, options) : {status:201,json:async () => ({message:"Success"})};
    }
  };
  for (const name of [...html.matchAll(/\bjsPsych[A-Z]\w+/g)].map(match => match[0])) context[name] = function Plugin() {};
  let source = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
    .replace(/^  import .*;\r?\n/gm, "")
    .replace("  startExperiment();", "");
  source += `\nglobalThis.app = {startExperiment,finishSurveyAndSave,uploadCompletedSession,experimentConfig,dataSavingConfig,buildParticipantQuestionnaires,buildConsentAndEligibility,buildIntroductionAndPractice,buildSecondSessionChoice,buildCondition1Trials,buildCondition2Trials,setCompleted:value=>{completedSessions=value;},getCompleted:()=>completedSessions,sessionId};`;
  vm.runInNewContext(source,context,{filename:"index.html"});
  const app = context.app;
  state.currentAudioFile = "audio/0020.mp3";
  app.experimentConfig.skipSessionsForVerification = skip;
  app.experimentConfig.stimulusPoolSize = poolSize;
  return {app,state,context};
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

test("emotion resources load once only for listening Condition 1 in the selected language", async () => {
  for (const language of ["kor", "eng"]) for (const condition of [0, 1]) for (const skip of [false, true]) {
    const {app, state} = makeApp({language, condition, skip});
    await app.startExperiment();
    const expected = condition === 0 && !skip;
    assert.deepEqual(state.emotionLanguages, expected ? [language] : []);
    assert.equal(state.emotionStyleRequests, Number(expected));
  }
  for (const failure of ["list", "styles"]) {
    const {app, state, context} = makeApp({skip: false,
      ...(failure === "list" ? {loadEmotions: async () => {throw new Error("TEST_EMOTION_LIST");}}
        : {loadEmotionStyles: async () => {throw new Error("TEST_EMOTION_STYLES");}})
    });
    await assert.rejects(app.startExperiment(), /TEST_EMOTION_/);
    assert.equal(state.runs, 0);
    assert.equal(state.requests.length, 0);
    assert(context.document.body.textContent.includes("STARTUP_FAILED"));
    assert.equal(state.emotionLanguages.length, 1);
  }
});

test("actual practice/main responses accept unlisted input and retain expressions, events and shortcuts", async () => {
  for (const language of ["kor", "eng"]) for (const phase of ["practice", "main"]) {
    const {app, state, context} = makeApp({language, skip: false});
    await app.startExperiment();
    const dom = createEmotionDom();
    state.display = dom.display;
    context.document.createElement = dom.document.createElement;
    context.navigator = {platform: "Win32"};
    const [listening, response] = app.buildCondition1Trials({audioFiles: ["audio/0020.mp3"], phase})[1].timeline;
    const [first, second] = language === "kor" ? ["가라앉은 기분", "중립"] : ["pride in family", "neutral"];
    const custom = language === "kor" ? '차분하지만 "낯선" 느낌' : 'Curiously calm, with "mixed" feelings';
    assert.equal(emotionVocabularies[language].resolve(custom), undefined);
    const fill = value => {dom.input.value = value; dom.input.fire("input");};
    const enter = options => dom.input.fire("keydown", {key: "Enter", ...options});
    const button = dom.node(".jspsych-btn");
    let completed = 0;
    button.addEventListener("click", () => completed++);
    state.now = 10000;
    listening.on_finish({});
    response.on_start(); response.on_load();
    fill(" \t "); enter();
    assert(button.disabled);
    assert.equal(dom.node("#emotion-keyword-tags").children.length, 0);
    state.now = 10500;
    fill(`  ${custom}  `); enter();
    assert(!button.disabled);
    assert.equal(dom.node("#emotion-keyword-message").textContent, "");
    assert.equal(dom.node("#emotion-keyword-tags").children[0].children[0].textContent, custom);
    fill(language === "eng" ? custom.toUpperCase() : custom); enter();
    assert(dom.node("#emotion-keyword-message").textContent);
    assert.equal(dom.node("#emotion-keyword-tags").children.length, 1);
    fill(language === "kor" ? "은기" : "PRIDEINFAM");
    dom.input.fire("keydown", {key: "ArrowDown"});
    state.now = 11000;
    enter();
    assert.equal(dom.input.value, "");
    state.now = 12000;
    fill(language === "kor" ? second : second.toUpperCase()); enter();
    fill(second); enter();
    assert(dom.node("#emotion-keyword-message").textContent);
    assert.equal(dom.node("#emotion-keyword-tags").children.length, 3);
    state.now = 12500;
    dom.node("#emotion-keyword-tags").children[1].children[1].click();
    fill("bad pending input"); enter({ctrlKey: true});
    assert.equal(completed, 0);
    fill("");
    dom.input.fire("compositionstart"); enter({ctrlKey: true});
    assert(button.disabled);
    assert.equal(completed, 0);
    dom.input.fire("compositionend");
    assert(!button.disabled);
    enter({ctrlKey: true});
    assert.equal(completed, 1);
    const data = {};
    response.on_finish(data);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), {
      emotion_keywords: [custom, second], keyword_count: 2,
      keyword_events: [
        {action: "add", keyword: custom, rt: 500},
        {action: "add", keyword: first, rt: 1000},
        {action: "add", keyword: second, rt: 2000},
        {action: "remove", keyword: first, rt: 2500}
      ]
    });
    assert(dom.node("#emotion-suggestions").hidden);
    assert.equal(dom.input.listeners.get("keydown").length, 0);
  }
});

function loadReplayResponse(app, state, context, condition, phase, index = 0) {
  const files = ["audio/0020.mp3", "audio/0040.mp3"];
  const trials = (condition === 0 ? app.buildCondition1Trials : app.buildCondition2Trials)({audioFiles:files,phase});
  const [listening,emotion,familiarity] = condition === 0 ? trials[1].timeline : trials.slice(1 + index * 3,4 + index * 3);
  const dom = createEmotionDom();
  state.display = dom.display;
  state.currentAudioFile = files[index];
  context.document.createElement = dom.document.createElement;
  context.navigator = {platform:"Win32"};
  listening.on_finish({});
  emotion.on_start?.();
  emotion.on_load();
  if (condition === 0) {
    dom.input.value = "neutral";
    dom.input.fire("input");
    dom.input.fire("keydown",{key:"Enter"});
  }
  const actions = dom.display.children.find(node=>node.className === "emotion-response-actions");
  assert(actions);
  const [anchor,button,error] = actions.children;
  assert.equal(anchor.selector,condition === 0 ? "#jspsych-html-button-response-btngroup" : "#jspsych-survey-likert-next");
  assert.equal(button.type,"button");
  assert.equal(button.textContent,"다시 듣기");
  assert.equal(error.hidden,true);
  return {dom,emotion,familiarity,button,error};
}

test("replay waits 200 ms, plays the current clip once, resets per trial and preserves responses and timing", async () => {
  for (const condition of [0,1]) for (const phase of ["main","practice"]) {
    const requests = [];
    let plays = 0, stops = 0;
    const player = {play(){plays++;},stop(){stops++;},addEventListener(){},removeEventListener(){}};
    const {app,state,context} = makeApp({condition,language:"eng",skip:false,
      getAudioPlayer:async file=>{requests.push(file);return player;}});
    await app.startExperiment();
    for (let index=0;index<2;index++) {
      state.now = 10000 + index * 20000;
      const {dom,emotion,familiarity,button} = loadReplayResponse(app,state,context,condition,phase,index);
      button.click();
      assert.equal(button.disabled,true);
      assert.equal(plays,index);
      assert.equal(requests.length,index);
      button.fire("click"); // The guard also rejects duplicate events during the delay.
      assert.equal(state.timers.size,1);
      const [id,timer] = [...state.timers][0];
      assert.equal(timer.delay,200);
      state.timers.delete(id);
      state.now += 200;
      await timer.callback();
      assert.deepEqual(requests,["audio/0020.mp3","audio/0040.mp3"].slice(0,index+1));
      assert.equal(plays,index+1);
      button.fire("click");
      assert.equal(state.timers.size,0);
      assert.equal(button.disabled,true);
      const response = {response:{pleasantness:4}};
      emotion.on_finish(response);
      assert.equal(stops,index+1);
      if (condition === 0) assert.deepEqual(Array.from(response.emotion_keywords),["neutral"]);
      else assert.equal(response.rating_pleasantness,5);
      assert(!Object.keys(response).some(key=>key.includes("replay")));
      state.display = createEmotionDom().display;
      familiarity.on_load();
      assert(!state.display.children.some(node=>node.className === "emotion-response-actions"));
      state.now += 5500;
      const familiarityRow = {response:{familiarity:4}};
      familiarity.on_finish(familiarityRow);
      assert.equal(familiarityRow.response_time_seconds,5.7);
      assert.equal(familiarityRow.familiarity_rating_1_to_9,5);
      if (condition === 0) assert.equal(dom.input.listeners.get("keydown").length,0);
    }
  }
});

test("submitting cancels replay during the delay or while the player is resolving", async () => {
  for (const condition of [0,1]) for (const pendingLoad of [false,true]) {
    let resolvePlayer, plays = 0, stops = 0, requests = 0;
    const player = {play(){plays++;},stop(){stops++;},addEventListener(){},removeEventListener(){}};
    const {app,state,context} = makeApp({condition,language:"eng",skip:false,
      getAudioPlayer:()=>{requests++;return new Promise(resolve=>{resolvePlayer=resolve;});}});
    await app.startExperiment();
    const {emotion,button} = loadReplayResponse(app,state,context,condition,"main");
    button.click();
    let pending;
    if (pendingLoad) {
      const [id,timer] = [...state.timers][0];
      state.timers.delete(id);
      pending = timer.callback();
    }
    emotion.on_finish({response:{pleasantness:4}});
    assert.equal(state.timers.size,0);
    if (pendingLoad) {resolvePlayer(player);await pending;}
    assert.equal(requests,Number(pendingLoad));
    assert.equal(plays,0);
    assert.equal(stops,0);
  }
});

test("replay loading, playback and media errors are visible and never permit another replay", async () => {
  for (const condition of [0,1]) for (const failure of ["load","play","media"]) {
    const listeners = new Map();
    const player = {play(){if (failure === "play") throw new Error("TEST_PLAY_FAILED");},stop(){},
      addEventListener(name,handler){listeners.set(name,handler);},removeEventListener(name){listeners.delete(name);}};
    const {app,state,context} = makeApp({condition,language:"eng",skip:false,
      getAudioPlayer:async ()=>{if (failure === "load") throw new Error("TEST_LOAD_FAILED");return player;}});
    await app.startExperiment();
    const {emotion,button,error} = loadReplayResponse(app,state,context,condition,"main");
    button.click();
    const [id,timer] = [...state.timers][0];
    state.timers.delete(id);
    await timer.callback();
    if (failure === "media") listeners.get("error")();
    assert.equal(error.hidden,false);
    assert.match(error.textContent,/could not be replayed/);
    assert(button.disabled);
    button.fire("click");
    assert.equal(state.timers.size,0);
    emotion.on_finish({response:{pleasantness:4}});
    assert.equal(listeners.size,0);
  }
});

function finishRows(state, language="kor", condition="condition_1", sessions=0) {
  const musicRows = buildGmsiTrials({
    dataset: gmsiDatasets[language === "eng" ? "en" : "ko"], plugin:function SurveyLikert(){}, condition
  }).map((trial, page) => {
    const row = {
      ...state.properties, ...structuredClone(trial.data), trial_type:"survey-likert",
      response:Object.fromEntries(trial.questions.map((question, index) => [question.name, (page * 9 + index) % 7])),
      note:'한글, "quoted"\nsecond line'
    };
    trial.on_finish(row);
    return row;
  });
  state.rows = [
    {...state.properties, task:"consent",consented:true,response:{consent_decision:"agree"},trial_type:"survey-html-form"},
    {...state.properties, task:"eligibility",response:{
      eligibility_1:"yes",eligibility_2:"no",eligibility_3:"no",eligibility_4:"no"
    },trial_type:"survey-html-form"},
    {...state.properties, task:"demographics",trial_type:"survey-html-form",response:{age:"23",gender:"male",education:"bachelor"}},
    ...(state.properties.verification_skip_sessions ? [] : practiceRows(state.properties)),
    ...experimentRows(state.properties,sessions),
    ...musicRows,
    ...completedPages(datasets[language === "eng" ? "en" : "ko"], condition).map(row => ({...state.properties,...row})),
    {...state.properties, task:"contact_information",phase:"questionnaire",trial_type:"survey-html-form",response:{phone_number_1:"",phone_number_2:"",phone_number_3:"",phone_number:"",email_address:""}},
    {...state.properties, task:"debrief",trial_type:"html-button-response",debrief_acknowledged:true,time_elapsed:1800000}
  ];
}

test("pilot eligibility form and procedural export use the same four questions in both conditions", async () => {
  for (const condition of [0,1]) {
    const {app,state} = makeApp({condition});
    await app.startExperiment();
    const eligibility = state.timeline.find(trial => trial.data?.task === "eligibility");
    const fields = [...new Set(Array.from(eligibility.html.matchAll(/name="(eligibility_\d+)"/g), match => match[1]))];
    assert.deepEqual(fields,["eligibility_1","eligibility_2","eligibility_3","eligibility_4"]);
    finishRows(state,"kor",state.properties.condition);
    const parsed = parseCsv(createProceduralCsv(state.rows,{...metadata,condition:state.properties.condition}));
    assert.deepEqual(parsed[0].filter(field => field.startsWith("eligibility_")),fields);
  }
});

test("normal/skip timelines in both conditions keep demographics first and Big Five after listening", async () => {
  for (const condition of [0,1]) for (const skip of [false,true]) for (const language of ["eng","kor"]) {
    const {app,state} = makeApp({condition,skip,language});
    await app.startExperiment();
    assert.equal(state.runs,1);
    const tasks = Array.from(state.timeline, trial => trial.data?.task);
    assert.deepEqual(tasks.slice(0,3),["consent","eligibility","demographics"]);
    const musicPosition = tasks.indexOf("musical_sophistication");
    assert.equal(tasks.filter(task => task === "demographics").length,1);
    assert.equal(tasks.filter(task => task === "personality_traits").length,12);
    assert.deepEqual(tasks.slice(musicPosition),[...Array(2).fill("musical_sophistication"),...Array(12).fill("personality_traits"),"contact_information","debrief"]);
    const music = state.timeline.slice(musicPosition, musicPosition + 2);
    assert.deepEqual(Array.from(music, trial => trial.questions.length), [9,9]);
    assert(music.every(trial => trial.data.questionnaire_language === (language === "eng" ? "en" : "ko")));
    assert(music.every(trial => trial.data.is_placeholder === false));
    const bigFive = state.timeline[musicPosition + 2];
    assert.equal(bigFive.data.questionnaire_language, language === "eng" ? "en" : "ko");
    assert.equal(state.properties.verification_skip_sessions,skip);
    assert.equal(app.getCompleted(),0);
    if (skip) {
      assert.equal(state.metadataRequests,0);
      assert.equal(state.samplingRequests.length,0);
      assert.equal(musicPosition,3);
      assert.equal(state.timeline.some(trial => trial.timeline),false);
    } else {
      assert.equal(state.metadataRequests,1);
      assert.equal(tasks.includes("second_session_choice"),true);
      const choicePosition = tasks.indexOf("second_session_choice");
      const first = state.timeline[choicePosition - 1];
      const second = state.timeline[choicePosition + 1];
      first.on_timeline_finish();
      assert.equal(app.getCompleted(),1);
      const choice = state.timeline[choicePosition];
      choice.on_finish({response:1});
      assert.equal(second.conditional_function(),false);
      choice.on_finish({response:0});
      assert.equal(second.conditional_function(),true);
      second.timeline[0].on_timeline_finish();
      assert.equal(app.getCompleted(),2);
      assert.equal(first.data.session_number,1);
      assert.equal(second.timeline[0].data.session_number,2);
    }
  }
});

test("startup samples 63 distinct numbers from 1–200, maps them by 20 and reserves disjoint 3/30/30 batches", async () => {
  for (const condition of [0,1]) for (const reverse of [false,true]) {
    const {app,state} = makeApp({condition,skip:false,sample:(pool,count)=>{
      assert.deepEqual(Array.from(pool),Array.from({length:200},(_,i)=>i+1));
      return reverse ? pool.slice(-count).reverse() : pool.slice(0,count);
    }});
    await app.startExperiment();
    assert.deepEqual(state.samplingRequests,[{size:200,count:63}]);
    assert.equal(state.properties.stimulus_pool_size,200);
    assert.equal(state.properties.stimulus_first_number,20);
    const {practiceAudioFiles,audioFiles,secondSessionAudioFiles} = app.experimentConfig;
    assert.deepEqual([practiceAudioFiles.length,audioFiles.length,secondSessionAudioFiles.length],[3,30,30]);
    assert.equal(new Set([...practiceAudioFiles,...audioFiles,...secondSessionAudioFiles]).size,63);
    assert.deepEqual(Array.from(practiceAudioFiles),reverse
      ? ["audio/4000.mp3","audio/3980.mp3","audio/3960.mp3"]
      : ["audio/0020.mp3","audio/0040.mp3","audio/0060.mp3"]);
    assert.equal(audioFiles[0],reverse ? "audio/3940.mp3" : "audio/0080.mp3");
    assert.equal(secondSessionAudioFiles.at(-1),reverse ? "audio/2760.mp3" : "audio/1260.mp3");
    if (!reverse) assert.equal(secondSessionAudioFiles[16],"audio/1000.mp3");
    assert(![...practiceAudioFiles,...audioFiles,...secondSessionAudioFiles].includes("audio/practice.mp3"));
    const instructionsPosition = state.timeline.findIndex(trial=>trial.data?.task === "instructions");
    assert.deepEqual(Array.from(state.timeline[instructionsPosition + 1].audio),Array.from(practiceAudioFiles));
    const choicePosition = state.timeline.findIndex(trial=>trial.data?.task === "second_session_choice");
    assert.deepEqual(Array.from(state.timeline[choicePosition - 1].timeline[0].audio),Array.from(audioFiles));
    assert.deepEqual(Array.from(state.timeline[choicePosition + 1].timeline[0].timeline[0].audio),Array.from(secondSessionAudioFiles));
    const firstSessionTrials = state.timeline[choicePosition - 1].timeline;
    if (condition === 0) {
      assert.equal(firstSessionTrials[1].timeline_variables[0].stimulusId,reverse ? "3940" : "0080");
      assert.equal(firstSessionTrials[1].timeline_variables[0].workId,reverse ? "WORK_3940" : "WORK_80");
    } else {
      assert.equal(firstSessionTrials[1].data.stimulus_id,reverse ? "3940" : "0080");
      assert.equal(firstSessionTrials[1].data.work_id,reverse ? "WORK_3940" : "WORK_80");
    }
  }
});

test("practice uses one fresh reserved clip per attempt, permits early exit and disables a fourth attempt", async () => {
  for (const condition of [0,1]) for (const completedAttempts of [1,2,3]) {
    const {app,state} = makeApp({condition,skip:false});
    await app.startExperiment();
    const position = state.timeline.findIndex(trial=>trial.data?.task === "instructions");
    assert(state.timeline[position].pages.at(-1).includes("최대 3회"));
    const attempts = state.timeline[position + 2].timeline;
    assert.equal(attempts.length,3);
    const originalBatches = JSON.stringify(app.experimentConfig);
    for (const [index,attempt] of attempts.entries()) {
      assert.equal(attempt.conditional_function(),index < completedAttempts);
      if (index >= completedAttempts) continue;
      const start = attempt.timeline[0];
      const decision = attempt.timeline.at(-1);
      const startRow = {};
      start.on_finish(startRow);
      assert.equal(startRow.practice_attempt,index + 1);
      const responseNodes = attempt.timeline.slice(1,-1);
      const leaves = condition === 0 ? responseNodes[0].timeline : responseNodes;
      assert.equal(leaves.length,3);
      const [listening,emotion,familiarity] = leaves;
      assert.equal(emotion.data.task,condition === 0 ? "free_response" : "dimensional_rating");
      assert(leaves.every(node=>node.data.phase === "practice"));
      if (condition === 0) {
        assert.equal(responseNodes[0].timeline_variables.length,1);
        assert.equal(responseNodes[0].timeline_variables[0].audioFile,app.experimentConfig.practiceAudioFiles[index]);
      } else {
        assert.equal(listening.stimulus,app.experimentConfig.practiceAudioFiles[index]);
      }
      const listeningRow = {}, familiarityRow = {response:{familiarity:8}};
      state.now = 10000 * (index + 1); listening.on_finish(listeningRow);
      state.now += 500; familiarity.on_finish(familiarityRow);
      assert.equal(listeningRow.practice_attempt,index + 1);
      assert.equal(familiarityRow.practice_attempt,index + 1);
      assert.equal(familiarityRow.familiarity_rating_1_to_9,9);
      assert.equal(familiarityRow.response_time_seconds,0.5);
      assert.equal(/\bdisabled\b/.test(decision.button_html("다시 연습하기",0)),index === 2);
      assert.equal(/\bdisabled\b/.test(decision.button_html("본 실험 시작",1)),false);
      if (index === 2) assert.throws(()=>decision.on_finish({response:0}),/PRACTICE_DECISION_INVALID/);
      assert.throws(()=>decision.on_finish({response:null}),/PRACTICE_DECISION_INVALID/);
      const decisionRow = {response:index < completedAttempts - 1 ? 0 : 1};
      decision.on_finish(decisionRow);
      assert.equal(decisionRow.practice_attempt,index + 1);
      assert.equal(decisionRow.repeat_practice,index < completedAttempts - 1);
    }
    assert.equal(JSON.stringify(app.experimentConfig),originalBatches);
    assert.equal(state.samplingRequests.length,1);
  }
});

test("undersized pools, invalid sampling and overlapping practice clips fail explicitly", async () => {
  const undersized = makeApp({skip:false,poolSize:62});
  await assert.rejects(undersized.app.startExperiment(),/STIMULUS_POOL_CONFIG_INVALID/);
  assert.equal(undersized.state.runs,0);
  for (const step of [0,-20,1.5,undefined,Number.MAX_SAFE_INTEGER]) {
    const {app,state} = makeApp({skip:false});
    app.experimentConfig.stimulusNumberStep = step;
    await assert.rejects(app.startExperiment(),/STIMULUS_POOL_CONFIG_INVALID/);
    assert.equal(state.metadataRequests,0);
    assert.equal(state.runs,0);
  }
  const missingMetadata = makeApp({skip:false});
  missingMetadata.app.experimentConfig.stimulusFirstNumber = 21;
  await assert.rejects(missingMetadata.app.startExperiment(),/STIMULUS_METADATA_MISSING_CLIP/);
  assert.equal(missingMetadata.state.runs,0);
  for (const sample of [
    (pool,count)=>pool.slice(0,count - 1),
    (pool,count)=>Array(count).fill(pool[0]),
    (pool,count)=>[0,...pool.slice(1,count)],
    (pool,count)=>[201,...pool.slice(1,count)],
    (pool,count)=>[1.5,...pool.slice(1,count)]
  ]) {
    const {app,state} = makeApp({skip:false,sample});
    await assert.rejects(app.startExperiment(),/STIMULUS_SELECTION_INVALID/);
    assert.equal(state.runs,0);
  }
  for (const condition of [0,1]) for (const source of ["audioFiles","secondSessionAudioFiles"]) {
    const {app} = makeApp({condition,skip:false});
    await app.startExperiment();
    app.experimentConfig.practiceAudioFiles[0] = app.experimentConfig[source][0];
    assert.throws(()=>app.buildIntroductionAndPractice(),/PRACTICE_STIMULI_INVALID/);
  }
});

test("contact page has three optional phone segments and email after Big Five in both timelines", async () => {
  for (const condition of [0,1]) for (const skip of [false,true]) {
    const {app,state} = makeApp({condition,skip});
    await app.startExperiment();
    const contacts = state.timeline.filter(trial => trial.data?.task === "contact_information");
    assert.equal(contacts.length,1);
    const contact = contacts[0];
    const position = state.timeline.indexOf(contact);
    assert.equal(state.timeline[position - 1].data.task,"personality_traits");
    assert.equal(state.timeline[position + 1].data.task,"debrief");
    assert.equal(contact.data.condition,state.properties.condition);
    assert.equal(contact.data.phase,"questionnaire");
    assert.equal(contact.dataAsArray,false);
    assert.equal(contact.button_label,"다음");
    const inputs = Array.from(contact.html.matchAll(/<input\b[^>]*>/g), match => match[0]);
    assert.equal(inputs.length,4);
    for (const [index, length] of [3,4,4].entries()) {
      assert(inputs[index].includes(`name="phone_number_${index + 1}" type="tel"`));
      assert(inputs[index].includes('inputmode="numeric"'));
      assert(inputs[index].includes(`pattern="[0-9]{${length}}" maxlength="${length}"`));
    }
    assert.match(inputs[3],/name="email_address" type="email"/);
    assert(inputs.every(input => !/\brequired\b|\bvalue\s*=/.test(input)));
  }
});

test("contact completion retains phone segments and rejects incomplete or non-digit numbers", async () => {
  for (const condition of [0,1]) {
    const {app,state} = makeApp({condition});
    await app.startExperiment();
    const contact = state.timeline.find(trial => trial.data?.task === "contact_information");
    for (const parts of [["","",""],["010","0123","4567"],["000","0000","0000"]]) {
      const response = {phone_number_1:parts[0],phone_number_2:parts[1],phone_number_3:parts[2],email_address:""};
      const raw = structuredClone(response);
      contact.on_finish({response});
      assert.deepEqual(response,{...raw,phone_number:parts.join("")});
    }
    for (const parts of [["010","",""],["","1234","5678"],["01","1234","5678"],["010","1234","567"],["010","1234","56789"],["abc","1234","5678"],[undefined,"",""],[10,"1234","5678"]]) {
      assert.throws(() => contact.on_finish({response:{phone_number_1:parts[0],phone_number_2:parts[1],phone_number_3:parts[2]}}),/CONTACT_PHONE_INVALID/);
    }
  }
});

test("optional contacts retain raw phone segments in JSON and export digits only to procedural CSV", async () => {
  const responses = [
    {phone_number_1:"",phone_number_2:"",phone_number_3:"",email_address:""},
    {phone_number_1:"010",phone_number_2:"0123",phone_number_3:"4567",email_address:""},
    {phone_number_1:"",phone_number_2:"",phone_number_3:"",email_address:"pilot@example.invalid"},
    {phone_number_1:"000",phone_number_2:"0000",phone_number_3:"0000",email_address:"pilot@example.invalid"}
  ];
  for (const condition of [0,1]) for (const response of responses) {
    const {app,state} = makeApp({condition});
    await app.startExperiment();
    finishRows(state,"kor",state.properties.condition);
    const contactRow = state.rows.find(row => row.task === "contact_information");
    contactRow.response = structuredClone(response);
    state.timeline.find(trial => trial.data?.task === "contact_information").on_finish(contactRow);
    const original = structuredClone(state.rows);
    await app.finishSurveyAndSave();
    assert.equal(state.requests.length,5);
    const [json,main,procedural,bigfive,gmsi] = state.requests.map(request => request.parsed);
    assert.deepEqual(JSON.parse(json.data).trials,original);
    const parsed = parseCsv(procedural.data);
    assert.deepEqual(parsed[0].slice(-2),["phone_number","email_address"]);
    assert.deepEqual(parsed[1].slice(-2),[response.phone_number_1 + response.phone_number_2 + response.phone_number_3,response.email_address]);
    for (const file of [main,bigfive,gmsi]) {
      assert(!parseCsv(file.data)[0].some(field => ["phone_number","email_address"].includes(field)));
    }
    assert.deepEqual(state.rows,original);
  }
});

test("five successful files share ID; JSON retains all raw data; experiment/procedural CSVs contain only agreed fields", async () => {
  for (const language of ["eng","kor"]) {
    const {app,state} = makeApp({language});
    await app.startExperiment();
    finishRows(state,language);
    const original = structuredClone(state.rows);
    const pending = app.finishSurveyAndSave();
    await flush(); await pending;
    assert.equal(state.requests.length,5);
    assert.equal(app.finishSurveyAndSave(),pending);
    const [json,main,procedural,bigfive,gmsi] = state.requests.map(request => request.parsed);
    assert.equal(json.filename,`CCM_ccm_draft_07_${sessionId}.json`);
    assert.equal(main.filename,`CCM_ccm_draft_07_${sessionId}.csv`);
    assert.equal(procedural.filename,`CCM_ccm_draft_07_${sessionId}_procedural.csv`);
    assert.equal(bigfive.filename,`CCM_ccm_draft_07_${sessionId}_bigfive.csv`);
    assert.equal(gmsi.filename,`CCM_ccm_draft_07_${sessionId}_gmsi.csv`);
    const envelope = JSON.parse(json.data);
    assert.deepEqual(envelope.trials, original);
    assert.equal(envelope.session_id, sessionId);
    const mainParsed = parseCsv(main.data);
    assert.deepEqual(mainParsed,[ ["trial_no","work_id","session_id","familiarity","response_time_seconds"] ]);
    const procedureParsed = parseCsv(procedural.data);
    assert.deepEqual(procedureParsed[1],[sessionId,"","0","30","true","yes","no","no","no","0","0","",""]);
    const resultParsed = parseCsv(bigfive.data);
    assert.equal(resultParsed[1][resultParsed[0].indexOf("session_id")],sessionId);
    assert.equal(resultParsed[1][resultParsed[0].indexOf("completed_at")],envelope.completed_at);
    const musicParsed = parseCsv(gmsi.data);
    assert.equal(musicParsed[0].length,19);
    assert.equal(musicParsed[1][0],sessionId);
    assert.deepEqual(musicParsed[1].slice(1).map(Number),Array.from({length:18},(_,i)=>i%7+1));
    assert.deepEqual(state.rows,original);
    assert.equal(state.nodes["save-reference"].hidden,true);
    assert.equal(state.nodes["save-retry"].hidden,true);
    assert.equal(/Big Five|N_score|CSV|JSON|high|neutral/.test(state.nodes["save-status"].textContent),false);
  }
});

test("normal runs export 30/60 combined music trials for either condition and preserve raw JSON", async () => {
  for (const condition of [0,1]) for (const sessions of [1,2]) {
    const {app,state} = makeApp({condition,skip:false});
    await app.startExperiment();
    const choice = state.timeline.findIndex(trial=>trial.data?.task === "second_session_choice");
    state.timeline[choice-1].on_timeline_finish();
    if (sessions === 2) state.timeline[choice+1].timeline[0].on_timeline_finish();
    finishRows(state,"kor",condition === 0 ? "condition_1" : "condition_2",sessions);
    const before = structuredClone(state.rows);
    await app.finishSurveyAndSave();
    assert.equal(state.requests.length,5);
    const [json,experiment,procedure] = state.requests.map(request=>request.parsed);
    assert.deepEqual(JSON.parse(json.data).trials,before);
    const parsed = parseCsv(experiment.data);
    assert.equal(parsed.length,sessions*30+1);
    assert.equal(parsed.at(-1)[0],String(sessions*30));
    assert.equal(parsed[0][2],"session_id");
    assert.equal(parsed[1][2],sessionId);
    assert.equal(parsed[0].includes("task"),false);
    assert.equal(parsed[0].includes("stimulus_id"),false);
    assert.equal(parsed[0].includes("experiment_version"),false);
    const summary = parseCsv(procedure.data);
    assert.equal(summary[1][1],condition === 0 ? "condition_1" : "condition_2");
    assert.equal(summary[1][2],String(sessions));
    assert.equal(summary[1][summary[0].indexOf("practice_sessions_completed")],"2");
    assert.deepEqual(state.rows,before);
  }
});

test("main response counters follow presentation order, match within each clip and restart in each session", async () => {
  for (const condition of [0,1]) for (const language of ["kor","eng"]) {
    const {app,state,context} = makeApp({condition,language,skip:false,shuffle:array=>[...array].reverse()});
    await app.startExperiment();
    const {display, document, counters} = createEmotionDom();
    state.display = display;
    context.document.createElement = document.createElement;
    context.navigator = {platform:"Win32"};

    const choice = state.timeline.findIndex(trial=>trial.data?.task === "second_session_choice");
    const sessions = [state.timeline[choice - 1],state.timeline[choice + 1].timeline[0]];
    for (const session of sessions) {
      const trials = session.timeline;
      if (condition === 0) {
        assert.equal(trials[1].randomize_order,true);
        assert.throws(()=>trials[1].timeline[2].on_load(),/TRIAL_COUNTER_INVALID/);
      } else {
        // Shuffling changes source positions; the first displayed clip is still 1/30.
        assert.equal(trials[1].data.source_index,30);
      }
      for (let index=0;index<30;index++) {
        const [listening,emotion,familiarity] = condition === 0
          ? trials[1].timeline : trials.slice(1 + index * 3,4 + index * 3);
        counters.length = 0;
        state.now = 10000 + index * 1000;
        const listeningRow = {};
        listening.on_finish(listeningRow);
        assert.deepEqual(Object.keys(listeningRow),["excerpt_ended_at_ms"]);
        emotion.on_start?.();
        emotion.on_load();
        familiarity.on_load();
        assert.deepEqual(counters,[
          {selector:condition === 0 ? "#jspsych-html-button-response-btngroup" : "#jspsych-survey-likert-next",text:`${index + 1}/30`,className:"trial-counter"},
          {selector:"#jspsych-survey-likert-next",text:`${index + 1}/30`,className:"trial-counter"}
        ]);
        state.now += 500;
        const familiarityRow = {response:{familiarity:4}};
        familiarity.on_finish(familiarityRow);
        assert.equal(familiarityRow.response_time_seconds,0.5);
        assert.equal(familiarityRow.familiarity_rating_1_to_9,5);
      }
    }

    counters.length = 0;
    const position = state.timeline.findIndex(trial=>trial.data?.task === "instructions");
    for (const attempt of state.timeline[position + 2].timeline) {
      const responses = attempt.timeline.slice(1,-1);
      const [,emotion,familiarity] = condition === 0 ? responses[0].timeline : responses;
      emotion.on_start?.();
      emotion.on_load();
      familiarity.on_load();
    }
    for (const trial of state.timeline.filter(trial=>trial.data?.phase === "questionnaire")) {
      trial.on_load?.();
    }
    assert.deepEqual(counters,[]);
  }
});

test("actual trial callbacks time from clip end to familiarity submission across both response formats and practice", async () => {
  for (const condition of [0,1]) for (const phase of ["practice","main"]) {
    const {app,state} = makeApp({condition,skip:false});
    await app.startExperiment();
    const builder = condition === 0 ? app.buildCondition1Trials : app.buildCondition2Trials;
    const trials = builder({audioFiles:["audio/0020.mp3"],phase});
    const [listening,,familiarity] = condition === 0 ? trials[1].timeline : trials.slice(1,4);
    const listeningRow = {}, familiarityRow = {response:{familiarity:8}};
    assert.throws(()=>familiarity.on_finish(familiarityRow),/TIMING_INVALID/);
    state.now = 100000;
    listening.on_finish(listeningRow);
    state.now = 109500;
    familiarity.on_finish(familiarityRow);
    assert.equal(listeningRow.excerpt_ended_at_ms,100000);
    assert.equal(familiarityRow.familiarity_completed_at_ms,109500);
    assert.equal(familiarityRow.response_time_seconds,9.5);
    assert.equal(familiarityRow.familiarity_rating_1_to_9,9);
    state.now = 200000; listening.on_finish({});
    state.now = 200300; familiarity.on_finish(familiarityRow);
    assert.equal(familiarityRow.response_time_seconds,0.3);
  }
});

test("invalid experiment or procedural data prevents every upload", async () => {
  for (const [code,mutate] of [
    ["SAVE_CSV_SERIALIZE",state=>{state.rows.find(row=>row.phase === "main" && row.task === "familiarity").response_time_seconds = 0;}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{delete state.rows.find(row=>row.task === "eligibility").response.eligibility_4;}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.find(row=>row.task === "eligibility").response.eligibility_3 = "invalid";}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.splice(state.rows.findIndex(row=>row.task === "contact_information"),1);}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.splice(state.rows.length-1,0,structuredClone(state.rows.find(row=>row.task === "contact_information")));}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.find(row=>row.task === "contact_information").response.phone_number = 100;}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.find(row=>row.task === "instructions").rt = NaN;}]
  ]) {
    const {app,state} = makeApp({skip:false}); await app.startExperiment();
    const choice = state.timeline.findIndex(trial=>trial.data?.task === "second_session_choice");
    state.timeline[choice-1].on_timeline_finish();
    finishRows(state,"kor","condition_1",1); mutate(state);
    app.finishSurveyAndSave(); await flush();
    assert.equal(state.requests.length,0);
    assert.equal(state.display.dataset.submissionCode,code);
    assert.equal(state.nodes["save-reference"].hidden,false);
  }
});

test("sending has only the exact localized message; completion waits for the fifth confirmation", async () => {
  for (const language of ["eng","kor"]) {
    let release;
    const {app,state} = makeApp({language, upload:async number => number === 5
      ? new Promise(resolve => {release=()=>resolve({status:201,json:async()=>({message:"Success"})});})
      : {status:201,json:async()=>({message:"Success"})}});
    await app.startExperiment(); finishRows(state,language);
    let resolved=false;
    const promise=app.finishSurveyAndSave(); promise.then(()=>{resolved=true;});
    assert.equal(app.finishSurveyAndSave(),promise);
    await flush();
    assert.equal(state.requests.length,5);
    assert.equal(resolved,false);
    assert.equal(state.nodes["save-status"].textContent,language === "eng" ? "Sending results. Do not close the tab" : "결과를 전송중입니다. 창을 닫지 말고 잠시만 기다려 주십시오");
    assert.equal(state.nodes["save-reference"].hidden,true);
    assert.equal(state.nodes["save-retry"].hidden,true);
    assert.equal(state.nodes["save-download"].hidden,true);
    assert.equal(state.nodes["save-recovery-help"].hidden,true);
    assert.equal(state.archives.length,0);
    release(); await flush(); await promise;
    assert.equal(resolved,true);
  }
});

test("failure at each file position reveals ID, hides technical details, and retry skips saved files", async () => {
  for (const failedPosition of [1,2,3,4,5]) {
    let fail=true;
    const {app,state} = makeApp({upload:async number => {
      if (number === failedPosition && fail) {fail=false;throw new Error("PRIVATE_SERVER_DETAIL");}
      return {status:201,json:async()=>({message:"Success"})};
    }});
    await app.startExperiment(); finishRows(state);
    const promise = app.finishSurveyAndSave(); await flush();
    assert.equal(state.requests.length,failedPosition);
    assert.equal(state.nodes["save-reference"].hidden,false);
    assert(state.nodes["save-reference"].textContent.includes(sessionId));
    assert.equal(state.nodes["save-retry"].disabled,true);
    assert.equal(state.nodes["save-retry"].hidden,false);
    assert.equal(state.nodes["save-download"].hidden,false);
    assert.equal(/SAVE_|PRIVATE|HTTP|JSON|CSV|OSF/.test(state.nodes["save-status"].textContent),false);
    const failedRequest = state.requests.at(-1).body;
    await state.nodes["save-retry"].listeners.click();
    assert.equal(state.requests.length,failedPosition);
    const cooldown = [...state.timers.values()].find(timer=>timer.delay===5000);
    assert(cooldown); cooldown.callback();
    const retry = state.nodes["save-retry"].listeners.click();
    const concurrent = state.nodes["save-retry"].listeners.click();
    await retry; await concurrent; await promise;
    assert.equal(state.requests[failedPosition].body,failedRequest);
    assert.equal(state.requests.length,6);
    assert.equal(state.nodes["save-reference"].hidden,true);
    assert.equal(state.nodes["save-download"].hidden,true);
    assert.equal(state.nodes["save-recovery-help"].hidden,true);
    assert.equal(state.revokedUrls.length,1);
    assert.deepEqual(await readResultsZip(state.archives[0]),state.requests.slice(0,failedPosition-1)
      .concat(state.requests.slice(failedPosition)).map(request=>({filename:request.parsed.filename,data:request.parsed.data})));
  }
});

test("queue, duplicate, rejection and malformed confirmations never claim success", async () => {
  const cases = [
    {status:202,body:{},state:"queued"},
    {status:201,body:{queued:true,message:"Success"},state:"queued"},
    {status:409,jsonError:true,state:"duplicate"},
    {status:400,body:{error:"FILE_EXISTS"},state:"duplicate"},
    {status:400,body:{error:"UPLOAD_ERROR"},state:"unconfirmed"},
    {status:500,body:{error:"UPLOAD_EXCEPTION"},state:"unconfirmed"},
    {status:400,body:{error:"INVALID_DATA"},state:"rejected"},
    {status:201,body:{message:"Success",error:"UNKNOWN_PRIVATE_ERROR"},state:"rejected"},
    {status:200,body:{message:"Success"},state:"unconfirmed"},
    {status:201,body:{message:"Unexpected"},state:"unconfirmed"},
    {status:201,jsonError:true,state:"unconfirmed"},
    {status:503,body:{},state:"unconfirmed"}
  ];
  for (const failure of cases) {
    const {app,state} = makeApp({upload:async () => ({status:failure.status,json:async()=>{if(failure.jsonError)throw new SyntaxError("PRIVATE_BODY");return failure.body;}})});
    await app.startExperiment(); finishRows(state);
    let resolved=false;
    app.finishSurveyAndSave().then(()=>{resolved=true;}); await flush();
    assert.equal(resolved,false);
    assert.equal(state.requests.length,1);
    assert.equal(state.nodes["save-reference"].hidden,false);
    assert.equal(state.nodes["save-retry"].hidden,failure.state!=="unconfirmed");
    assert.equal(state.nodes["save-download"].hidden,false);
    assert.equal((await readResultsZip(state.archives[0])).length,5);
    assert.equal(/PRIVATE|SAVE_|DP_|HTTP|CSV|JSON|OSF/.test(state.nodes["save-status"].textContent),false);
  }
});

test("recovery ZIP contains all four CSVs and full JSON in both conditions/languages after a partial upload", async () => {
  for (const language of ["kor","eng"]) for (const conditionNumber of [0,1]) for (const sessions of [1,2]) {
    const condition = conditionNumber === 0 ? "condition_1" : "condition_2";
    const {app,state} = makeApp({language,condition:conditionNumber,skip:false,upload:async number=>{
      if (number === 3) throw new Error("TEST_NETWORK_FAILURE");
      return {status:201,json:async()=>({message:"Success"})};
    }});
    await app.startExperiment();
    const choice = state.timeline.findIndex(trial=>trial.data?.task === "second_session_choice");
    state.timeline[choice-1].on_timeline_finish();
    if (sessions === 2) state.timeline[choice+1].timeline[0].on_timeline_finish();
    finishRows(state,language,condition,sessions);
    const before = structuredClone(state.rows);
    let resolved=false;
    app.finishSurveyAndSave().then(()=>{resolved=true;});
    await flush();
    assert.equal(resolved,false);
    assert.equal(state.requests.length,3);
    const files = await readResultsZip(state.archives[0]);
    const envelope = JSON.parse(files[0].data);
    const {trials,...metadata} = envelope;
    const datasetLanguage = language === "kor" ? "ko" : "en";
    assert.deepEqual(trials,before);
    assert.deepEqual(files.map(file=>file.data),[
      files[0].data,
      createExperimentCsv(before,metadata),
      createProceduralCsv(before,metadata),
      createBigFiveCsv(before,datasets[datasetLanguage],metadata),
      createGmsiCsv(before,gmsiDatasets[datasetLanguage],metadata)
    ]);
    assert(files.every(file=>file.filename.includes(sessionId)));
    assert.equal(files.filter(file=>file.filename.endsWith(".csv")).length,4);
    assert.equal(files.filter(file=>file.filename.endsWith(".json")).length,1);
    for (let index=0;index<state.requests.length;index++) {
      assert.equal(files[index].filename,state.requests[index].parsed.filename);
      assert.equal(files[index].data,state.requests[index].parsed.data);
    }
    assert.equal(state.nodes["save-download"].download,`CCM_ccm_draft_07_${sessionId}.zip`);
    assert.equal(state.nodes["save-download"].href,"blob:TEST_1");
    assert(state.nodes["save-recovery-help"].textContent.includes("ben701@kaist.ac.kr"));
    assert.deepEqual(state.rows,before);
  }
});

test("archive-generation failure keeps upload unconfirmed and clearly reports that ZIP recovery failed", async () => {
  const {app,state} = makeApp({upload:async()=>{throw new Error("TEST_OFFLINE");},archive:()=>{throw new Error("PRIVATE_ZIP_ERROR");}});
  await app.startExperiment(); finishRows(state);
  let resolved=false;
  app.finishSurveyAndSave().then(()=>{resolved=true;}); await flush();
  assert.equal(resolved,false);
  assert.equal(state.requests.length,1);
  assert.equal(state.nodes["save-download"].hidden,true);
  assert.equal(state.nodes["save-recovery-help"].hidden,false);
  assert(state.nodes["save-recovery-help"].textContent.includes("ben701@kaist.ac.kr"));
  assert(!state.nodes["save-recovery-help"].textContent.includes("PRIVATE_ZIP_ERROR"));
  assert.equal(state.display.dataset.submissionCode,"SAVE_CONNECTION");
  assert.equal(state.display.dataset.recoveryCode,"SAVE_ZIP_PREPARE");
});

test("a rejected stylesheet or questionnaire-builder startup failure cannot start the timeline", async () => {
  const stylesheet = makeApp();
  stylesheet.context.surveyStartup.stylesReady = Promise.reject(new Error("TEST_STYLESHEET_FAILURE"));
  await assert.rejects(stylesheet.app.startExperiment(),/TEST_STYLESHEET_FAILURE/);
  assert.equal(stylesheet.state.runs,0);
  assert.equal(stylesheet.state.requests.length,0);
  assert(stylesheet.context.document.body.textContent.includes(sessionId));
  const plugin = makeApp();
  plugin.context.jsPsychSurveyLikert = undefined;
  await assert.rejects(plugin.app.startExperiment(),/PLUGIN_UNAVAILABLE/);
  assert.equal(plugin.state.runs,0);
  assert(plugin.context.document.body.textContent.includes(sessionId));
});

test("timeouts before/after headers remain unconfirmed", async () => {
  for (const afterHeaders of [false,true]) {
    const {app,state} = makeApp({upload:async (_,options) => {
      const timedOut = () => new Promise((resolve,reject)=>options.signal.addEventListener("abort",()=>reject(new Error("Abort"))));
      return afterHeaders ? {status:201,json:timedOut} : timedOut();
    }});
    await app.startExperiment(); finishRows(state);
    app.finishSurveyAndSave(); await flush();
    const timer = [...state.timers.values()].find(timer=>timer.delay===30000);
    assert(timer); timer.callback(); await flush();
    assert.equal(state.display.dataset.submissionCode,afterHeaders ? "SAVE_RESPONSE_TIMEOUT" : "SAVE_REQUEST_TIMEOUT");
    assert.equal(state.nodes["save-retry"].hidden,false);
    assert.equal(state.nodes["save-reference"].hidden,false);
    assert.equal(state.requests.length,1);
  }
});

test("incomplete/invalid Big Five stops preparation before any upload", async () => {
  for (const mutation of [
    state => state.rows.splice(state.rows.findIndex(row=>row.bigfive_page===1),1),
    state => {state.rows.find(row=>row.bigfive_page===1).response[datasets.ko.items[0].id]=null;},
    state => {state.rows.find(row=>row.bigfive_page===12).bigfive_result.N.score++;}
  ]) {
    const {app,state} = makeApp(); await app.startExperiment(); finishRows(state); mutation(state);
    app.finishSurveyAndSave(); await flush();
    assert.equal(state.requests.length,0);
    assert.equal(state.nodes["save-reference"].hidden,false);
    assert.equal(state.nodes["save-download"].hidden,true);
    assert.equal(state.archives.length,0);
    assert.equal(state.display.dataset.submissionCode,"SAVE_BIGFIVE_SERIALIZE");
  }
});

test("incomplete/invalid GMSI stops preparation before any upload", async () => {
  for (const mutation of [
    state => state.rows.splice(state.rows.findIndex(row=>row.gmsi_page===2),1),
    state => {state.rows.find(row=>row.gmsi_page===1).response.AE_01=null;},
    state => {state.rows.find(row=>row.gmsi_page===2).gmsi_answers[0].response_1_to_7=1;}
  ]) {
    const {app,state} = makeApp(); await app.startExperiment(); finishRows(state); mutation(state);
    app.finishSurveyAndSave(); await flush();
    assert.equal(state.requests.length,0);
    assert.equal(state.nodes["save-reference"].hidden,false);
    assert.equal(state.nodes["save-download"].hidden,true);
    assert.equal(state.archives.length,0);
    assert.equal(state.display.dataset.submissionCode,"SAVE_GMSI_SERIALIZE");
  }
});

test("declined consent, unfinished debrief and unavailable questionnaire never upload", async () => {
  for (const consented of [false,true]) {
    const {app,state} = makeApp(); await app.startExperiment(); finishRows(state);
    if (!consented) state.rows[0].consented=false;
    else state.rows.at(-1).debrief_acknowledged=false;
    assert.equal(app.finishSurveyAndSave(),undefined);
    assert.equal(state.requests.length,0);
  }
  const {app,state,context} = makeApp({load:async()=>{throw new Error("DATASET_MISSING");}});
  await assert.rejects(app.startExperiment(),/DATASET_MISSING/);
  assert.equal(state.runs,0);
  assert.equal(state.requests.length,0);
  assert(context.document.body.textContent.includes(sessionId));
  const musicFailure = makeApp({loadMusic:async()=>{throw new Error("GMSI_MISSING");}});
  await assert.rejects(musicFailure.app.startExperiment(),/GMSI_MISSING/);
  assert.equal(musicFailure.state.runs,0);
  assert.equal(musicFailure.state.requests.length,0);
  assert(musicFailure.context.document.body.textContent.includes(sessionId));
});
