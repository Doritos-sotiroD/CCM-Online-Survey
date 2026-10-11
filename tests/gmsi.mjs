import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ITEM_IDS, buildGmsiTrials, decodeGmsiPage, loadGmsi, validateGmsiDataset
} from "../questionnaires/gmsi/questionnaire.js";
import { createGmsiCsv } from "../questionnaires/gmsi/export.js";

const datasets = Object.fromEntries(await Promise.all(["en", "ko"].map(async language => [
  language, JSON.parse(await readFile(new URL(`../questionnaires/gmsi/data/${language}.json`, import.meta.url), "utf8"))
])));
const expectedIds = ["AE_01","AE_02","AE_05","AE_07","EM_04","MT_01","MT_02","MT_03","MT_06",
  "MT_07","PA_04","PA_08","SA_01","SA_02","SA_03","SA_04","SA_05","SA_06"];
const metadata = {session_id:"TEST_GMSI_ONLY",condition:"condition_1"};

function complete(dataset, raw = index => index % 7) {
  return buildGmsiTrials({dataset,plugin:function SurveyLikert(){},condition:metadata.condition}).map((trial,page) => {
    const row = {
      ...structuredClone(trial.data), session_id:metadata.session_id,
      response:Object.fromEntries(trial.questions.map((question,index)=>[question.name,raw(page*9+index)]))
    };
    trial.on_finish(row);
    return row;
  });
}

test("both datasets preserve source wording, selected IDs, Korean mapping and reverse keys", () => {
  const hashes = {
    en:"27dddec68e248269ae29db5c906195b10318f787d6e4c619dceaa10dfb9baa4a",
    ko:"c30176bdd766895a3ce70c42720a3c03a6aac59a1adc08aea49c55e98ab8924d"
  };
  assert.deepEqual(ITEM_IDS,expectedIds);
  for (const [language,dataset] of Object.entries(datasets)) {
    assert.equal(validateGmsiDataset(dataset,language),dataset);
    assert.deepEqual(dataset.items.map(item=>item.id),expectedIds);
    assert.deepEqual(dataset.items.map(item=>item.korean_item_number),[1,3,15,24,19,32,33,14,37,27,12,23,4,7,10,17,25,29]);
    assert.deepEqual(dataset.items.filter(item=>item.negative).map(item=>item.id),["MT_03","MT_07","PA_08","SA_04","SA_05"]);
    const content = dataset.items.map(item=>[item.id,item.text,item.source_text,dataset.choices[item.scale],item.negative,item.korean_item_number]);
    assert.equal(createHash("sha256").update(JSON.stringify(content)).digest("hex"),hashes[language]);
  }
  assert.deepEqual(datasets.en.items.map(({id,scale,negative})=>({id,scale,negative})),
    datasets.ko.items.map(({id,scale,negative})=>({id,scale,negative})));
  for (const mutate of [
    data=>data.items.push({...data.items[0],id:"BI_01"}),
    data=>data.items[1].id=data.items[0].id,
    data=>data.items[0].negative=true,
    data=>data.items[5].scale="agreement",
    data=>data.choices.agreement.pop()
  ]) {
    const bad=structuredClone(datasets.en); mutate(bad);
    assert.throws(()=>validateGmsiDataset(bad,"en"),/GMSI_/);
  }
});

test("language loader selects only the requested file and fails for missing or invalid data", async () => {
  const originalFetch=globalThis.fetch;
  const urls=[];
  try {
    globalThis.fetch=async url=>{
      urls.push(String(url));
      return {ok:true,json:async()=>structuredClone(String(url).endsWith("/ko.json")?datasets.ko:datasets.en)};
    };
    assert.equal((await loadGmsi("eng")).language,"en");
    assert.equal((await loadGmsi("kor")).language,"ko");
    assert(urls[0].endsWith("/gmsi/data/en.json"));
    assert(urls[1].endsWith("/gmsi/data/ko.json"));
    await assert.rejects(loadGmsi("unknown"),/LANGUAGE_INVALID/);
    globalThis.fetch=async()=>({ok:false});
    await assert.rejects(loadGmsi("kor"),/DATASET_HTTP_ERROR/);
    globalThis.fetch=async()=>({ok:true,json:async()=>datasets.en});
    await assert.rejects(loadGmsi("kor"),/DATASET_INVALID/);
  } finally {globalThis.fetch=originalFetch;}
});

test("exactly two pages of nine required seven-choice items preserve CSV order in both languages", () => {
  for (const dataset of Object.values(datasets)) {
    const trials=buildGmsiTrials({dataset,plugin:function SurveyLikert(){},condition:"condition_2"});
    assert.equal(trials.length,2);
    assert.deepEqual(trials.flatMap(trial=>trial.questions.map(question=>question.name)),expectedIds);
    trials.forEach((trial,page)=>{
      assert.equal(trial.questions.length,9);
      assert.equal(trial.randomize_question_order,false);
      assert.equal(trial.autocomplete,false);
      assert.deepEqual(trial.css_classes,["gmsi-questionnaire"]);
      assert.equal(trial.data.gmsi_page,page+1);
      assert.equal(trial.data.gmsi_page_count,2);
      assert.equal(trial.button_label,dataset.language==="en"?"Next":"다음");
      trial.questions.forEach((question,index)=>{
        assert.equal(question.required,true);
        assert.equal(question.default_response,null);
        assert.equal(question.labels.length,7);
        assert.deepEqual(question.labels,dataset.choices[dataset.items[page*9+index].scale]);
      });
    });
  }
});

test("every selection maps to 1–7 without reversal; invalid and out-of-order responses fail", () => {
  for (const dataset of Object.values(datasets)) for (let raw=0;raw<7;raw++) {
    const pages=complete(dataset,()=>raw);
    assert.equal(pages[0].gmsi_completed_at,undefined);
    assert(Number.isFinite(Date.parse(pages[1].gmsi_completed_at)));
    for (const answer of pages.flatMap(page=>page.gmsi_answers)) {
      assert.equal(answer.response_index,raw);
      assert.equal(answer.response_1_to_7,raw+1);
      assert.equal(answer.response_text,dataset.choices[answer.scale][raw]);
    }
  }
  const valid=Object.fromEntries(expectedIds.slice(0,9).map(id=>[id,0]));
  for (const raw of [null,-1,7,"1",NaN]) {
    assert.throws(()=>decodeGmsiPage(datasets.en,1,{...valid,AE_01:raw}),/RESPONSE_INVALID/);
  }
  assert.throws(()=>decodeGmsiPage(datasets.en,1,{}),/RESPONSE_INCOMPLETE/);
  assert.throws(()=>decodeGmsiPage(datasets.en,3,valid),/PAGE_INVALID/);
  const trials=buildGmsiTrials({dataset:datasets.en,plugin:function SurveyLikert(){},condition:"condition_1"});
  assert.throws(()=>trials[1].on_finish({response:valid}),/PAGE_ORDER_INVALID/);
});

test("scorer CSV contains exactly session_id and 18 unreversed item codes with no mutation", () => {
  for (const dataset of Object.values(datasets)) for (let raw=0;raw<7;raw++) {
    const pages=complete(dataset,()=>raw);
    const original=structuredClone(pages);
    const csv=createGmsiCsv(pages,dataset,metadata);
    const [header,row]=csv.trimEnd().split("\r\n").map(line=>line.split(",").map(cell=>JSON.parse(cell)));
    assert.deepEqual(header,["session_id",...expectedIds]);
    assert.deepEqual(row,[metadata.session_id,...Array(18).fill(String(raw+1))]);
    assert.deepEqual(pages,original);
  }
});

test("export rejects missing, repeated, changed, mismatched, or unfinished questionnaire data", () => {
  const pages=complete(datasets.ko);
  assert.throws(()=>createGmsiCsv(pages.slice(1),datasets.ko,metadata),/EXPORT_INCOMPLETE/);
  assert.throws(()=>createGmsiCsv([pages[0],pages[0]],datasets.ko,metadata),/EXPORT_PAGE_INVALID/);
  assert.throws(()=>createGmsiCsv(pages,datasets.en,metadata),/EXPORT_PAGE_INVALID/);
  for (const mutate of [
    rows=>rows[0].response.AE_01=6,
    rows=>rows[1].questionnaire_version="changed",
    rows=>rows[0].session_id="other-session",
    rows=>delete rows[1].gmsi_completed_at
  ]) {
    const bad=structuredClone(pages); mutate(bad);
    assert.throws(()=>createGmsiCsv(bad,datasets.ko,metadata),/GMSI_/);
  }
});
