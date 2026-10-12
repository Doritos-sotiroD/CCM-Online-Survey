import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import {
  buildBigFiveTrials, decodeBigFivePage, loadBigFive, validateBigFiveDataset
} from "../questionnaires/bigfive/questionnaire.js";
import { scoreBigFive } from "../questionnaires/bigfive/scoring.js";
import { createBigFiveCsv } from "../questionnaires/bigfive/export.js";
import { buildGmsiTrials } from "../questionnaires/gmsi/questionnaire.js";
import { createGmsiCsv } from "../questionnaires/gmsi/export.js";
import { createExperimentCsv, createProceduralCsv } from "../exports/study.js";
import { musicRows as experimentRows, practiceRows } from "./study-fixtures.mjs";

const datasets = Object.fromEntries(await Promise.all(["en", "ko"].map(async language => [
  language, JSON.parse(await readFile(new URL(`../questionnaires/bigfive/data/${language}.json`, import.meta.url), "utf8"))
])));
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const gmsiDatasets = Object.fromEntries(await Promise.all(["en", "ko"].map(async language => [
  language, JSON.parse(await readFile(new URL(`../questionnaires/gmsi/data/${language}.json`, import.meta.url), "utf8"))
])));
const sessionId = "TEST_BIGFIVE_ONLY";
const metadata = {
  session_id: sessionId, experiment_version: "ccm_draft_06", condition: "condition_1",
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
function makeApp({language="kor", condition=0, skip=true, upload,
  load=async language => structuredClone(datasets[language === "eng" ? "en" : "ko"]),
  loadMusic=async language => structuredClone(gmsiDatasets[language === "eng" ? "en" : "ko"])} = {}) {
  const nodes = Object.fromEntries(["save-status","save-reference","save-retry"].map(id => [id, {
    textContent:"", hidden:true, disabled:false, listeners:{}, addEventListener(name, handler){this.listeners[name]=handler;}
  }]));
  const display = {innerHTML:"", textContent:"", dataset:{}, querySelector(selector){assert(selector.slice(1) in nodes);return nodes[selector.slice(1)];}};
  const state = {rows:[], properties:{}, requests:[], timers:new Map(), nextTimer:0, display, nodes, metadataRequests:0, runs:0, now:0};
  const jsPsych = {
    randomization: {randomID:() => sessionId, sampleWithoutReplacement:(pool, count) => pool.slice(0,count), shuffle:array => [...array]},
    data: {addProperties(fields){Object.assign(state.properties,fields);for (const row of state.rows) Object.assign(row,fields);}, get:() => new DataCollection(state.rows)},
    getDisplayElement:() => display, run:timeline => {state.timeline=timeline;state.runs++;},
    timelineVariable:name => ({timelineVariable:name}), abortExperiment:message => {state.aborted=message;}
  };
  const context = {
    initJsPsych:options => {state.options=options;return jsPsych;},
    loadBigFive:load, buildBigFiveTrials, createBigFiveCsv,
    loadGmsi:loadMusic, buildGmsiTrials, createGmsiCsv,
    createExperimentCsv, createProceduralCsv, performance:{now:()=>state.now},
    AbortController, TextEncoder, Date, location:{protocol:"http:"}, document:{body:{}}, console,
    setTimeout:(callback, delay) => {const id=++state.nextTimer;state.timers.set(id,{callback,delay});return id;},
    clearTimeout:id => state.timers.delete(id),
    fetch:async (url, options) => {
      if (url === "metadata.csv") {
        state.metadataRequests++;
        return {ok:true,text:async () => "clip_filename,work_id\n" + Array.from({length:60},(_, i) => `${String(i+1).padStart(4,"0")}.mp3,WORK_${i+1}`).join("\n")};
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
    .replace('const lang = "kor";', `const lang = "${language}";`)
    .replace("  startExperiment();", "");
  source += `\nglobalThis.app = {startExperiment,finishSurveyAndSave,uploadCompletedSession,experimentConfig,dataSavingConfig,buildParticipantQuestionnaires,buildConsentAndEligibility,buildSecondSessionChoice,buildCondition1Trials,buildCondition2Trials,setCompleted:value=>{completedSessions=value;},getCompleted:()=>completedSessions,sessionId};`;
  vm.runInNewContext(source,context,{filename:"index.html"});
  const app = context.app;
  app.experimentConfig.skipSessionsForVerification = skip;
  app.experimentConfig.stimulusPoolSize = 60;
  return {app,state,context};
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
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
      eligibility_1:"yes",eligibility_2:"no",eligibility_3:"no",eligibility_4:"no",eligibility_5:"yes"
    },trial_type:"survey-html-form"},
    {...state.properties, task:"demographics",trial_type:"survey-html-form",response:{age:"23",gender:"prefer_not_to_say",education:"bachelor"}},
    ...(state.properties.verification_skip_sessions ? [] : practiceRows(state.properties)),
    ...experimentRows(state.properties,sessions),
    ...musicRows,
    ...completedPages(datasets[language === "eng" ? "en" : "ko"], condition).map(row => ({...state.properties,...row})),
    {...state.properties, task:"debrief",trial_type:"html-button-response",debrief_acknowledged:true,time_elapsed:1800000}
  ];
}

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
    assert.deepEqual(tasks.slice(musicPosition),[...Array(2).fill("musical_sophistication"),...Array(12).fill("personality_traits"),"debrief"]);
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
    assert.equal(json.filename,`CCM_ccm_draft_06_${sessionId}.json`);
    assert.equal(main.filename,`CCM_ccm_draft_06_${sessionId}.csv`);
    assert.equal(procedural.filename,`CCM_ccm_draft_06_${sessionId}_procedural.csv`);
    assert.equal(bigfive.filename,`CCM_ccm_draft_06_${sessionId}_bigfive.csv`);
    assert.equal(gmsi.filename,`CCM_ccm_draft_06_${sessionId}_gmsi.csv`);
    const envelope = JSON.parse(json.data);
    assert.deepEqual(envelope.trials, original);
    assert.equal(envelope.session_id, sessionId);
    const mainParsed = parseCsv(main.data);
    assert.deepEqual(mainParsed,[ ["trial_no","work_id","session_id","familiarity","response_time_seconds"] ]);
    const procedureParsed = parseCsv(procedural.data);
    assert.deepEqual(procedureParsed[1],[sessionId,"","0","30","true","yes","no","no","no","yes","0","0"]);
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
    assert.equal(summary[1].at(-1),"2");
    assert.deepEqual(state.rows,before);
  }
});

test("actual trial callbacks time from clip end to familiarity submission across both response formats and practice", async () => {
  for (const condition of [0,1]) for (const phase of ["practice","main"]) {
    const {app,state} = makeApp({condition,skip:false});
    await app.startExperiment();
    const builder = condition === 0 ? app.buildCondition1Trials : app.buildCondition2Trials;
    const trials = builder({audioFiles:["audio/0001.mp3"],phase});
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
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{delete state.rows.find(row=>row.task === "eligibility").response.eligibility_5;}],
    ["SAVE_PROCEDURAL_SERIALIZE",state=>{state.rows.find(row=>row.task === "eligibility").response.eligibility_3 = "invalid";}],
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
  }
});

test("queue, duplicate, rejection and malformed confirmations never claim success", async () => {
  const cases = [
    {status:202,body:{},state:"queued"},
    {status:201,body:{queued:true,message:"Success"},state:"queued"},
    {status:409,jsonError:true,state:"duplicate"},
    {status:400,body:{error:"OSF_FILE_EXISTS"},state:"duplicate"},
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
    assert.equal(/PRIVATE|SAVE_|DP_|HTTP|CSV|JSON|OSF/.test(state.nodes["save-status"].textContent),false);
  }
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
