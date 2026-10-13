import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateBaseCv, type BaseCv } from "../src/cv.ts";
import { titleFilter } from "../src/fetch.ts";
import { finalizeScore, matchPercent, validateScore, type ScoreInput } from "../src/score.ts";
import { parseHimalayas, parseJobicy, parseLinkedInDetail, parseLinkedInSearch } from "../src/sources.ts";
import { namedTerms, validateTailoring, type TailoredCv } from "../src/tailor.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const cv = JSON.parse(fixture("cv.sample.json")) as BaseCv;
const config = JSON.parse(readFileSync(new URL("../config/jobhunter.json", import.meta.url), "utf8"));

function score(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    requirements: [
      { text: "5+ years IT project management", importance: "must", status: "met", evidence: ["e1.b1", "e2.b1"] },
      { text: "SAP S/4HANA delivery", importance: "must", status: "met", evidence: ["skill:SAP S/4HANA"] },
      { text: "Agile delivery", importance: "must", status: "met", evidence: ["e1.b2"] },
      { text: "German B2", importance: "nice", status: "gap", evidence: [] },
    ],
    contractGate: "PASS", contractNote: "B2B", locationGate: "PASS", locationNote: "Prague hybrid",
    languageGate: "PASS", languageNote: "English", dayRate: null, summary: "Strong SAP fit.", redFlags: [],
    ...overrides,
  };
}

test("sample CV is valid", () => assert.deepEqual(validateBaseCv(cv), []));

test("match percent weights must=2 nice=1 and partial=0.5", () => {
  assert.equal(matchPercent(score().requirements), 85.7); // 6 of 7
  assert.equal(matchPercent([{ text: "a", importance: "must", status: "partial", evidence: ["e1.b1"] }, { text: "b", importance: "nice", status: "met", evidence: ["e1.b2"] }]), 66.7);
});

test("verdicts respect threshold, near-miss band and failing gates", () => {
  const allMet = score({ requirements: score().requirements.map((r) => ({ ...r, status: "met" as const, evidence: ["summary"] })) });
  assert.equal(finalizeScore(allMet, 90, 80, "m").verdict, "shortlist");
  assert.equal(finalizeScore(score(), 90, 80, "m").verdict, "near-miss");
  assert.equal(finalizeScore({ ...allMet, contractGate: "FAIL" }, 90, 80, "m").verdict, "gated");
});

test("score validation rejects invented evidence and evidence-free claims", () => {
  assert.deepEqual(validateScore(score(), cv), []);
  const bad = score({ requirements: [
    ...score().requirements,
    { text: "PMP", importance: "must", status: "met", evidence: ["cert:PMP"] },
    { text: "SAFe", importance: "nice", status: "partial", evidence: [] },
    { text: "Budget", importance: "must", status: "met", evidence: ["e9.b9"] },
  ] });
  const problems = validateScore(bad, cv).join("\n");
  assert.match(problems, /cert:PMP/);
  assert.match(problems, /SAFe.*cites no CV evidence/);
  assert.match(problems, /e9\.b9/);
});

const goodTailoring: TailoredCv = {
  headline: "IT Project Manager for SAP S/4HANA programmes",
  summary: "IT project manager with 12 years delivering SAP S/4HANA and Azure programmes for pharma and banking clients.",
  skills: ["SAP S/4HANA", "PRINCE2", "Scrum"],
  experience: [
    { id: "e1", bullets: [{ id: "e1.b1", text: "Led an SAP S/4HANA rollout in 6 countries with a 3.2 MEUR budget." }] },
    { id: "e2", bullets: [{ id: "e2.b1", text: "Delivered the core banking migration to Azure on time, 5% under budget." }] },
  ],
  keywordsCovered: ["SAP S/4HANA"],
};

test("tailoring accepts truthful rewording", () => assert.deepEqual(validateTailoring(goodTailoring, cv), []));

test("tailoring rejects invented tools, numbers, skills and dropped roles", () => {
  const bad: TailoredCv = {
    ...goodTailoring,
    summary: "Certified SAFe consultant with 15 years at Microsoft.",
    skills: ["SAP S/4HANA", "Kubernetes"],
    experience: [{ id: "e1", bullets: [{ id: "e1.b1", text: "Led an SAP rollout in 9 countries using ServiceNow." }] }],
  };
  const problems = validateTailoring(bad, cv).join("\n");
  assert.match(problems, /summary names things not in the CV: .*SAFe/);
  assert.match(problems, /Microsoft/);
  assert.match(problems, /summary uses numbers not in the CV: 15/);
  assert.match(problems, /Kubernetes/);
  assert.match(problems, /e1\.b1 adds numbers .*9/);
  assert.match(problems, /ServiceNow/);
  assert.match(problems, /missing: e2/);
});

test("named terms ignore sentence-initial capitals", () => {
  assert.deepEqual(namedTerms("Led the rollout. Managed vendors with Jira and SAP."), ["Jira", "SAP"]);
});

test("title filter keeps PM roles and drops construction/junior", () => {
  const keep = titleFilter(config);
  assert.ok(keep("Senior IT Project Manager - EWM in Pharma"));
  assert.ok(keep("Projektový manažer/Projektová manažerka do ICT"));
  assert.ok(keep("International Program Manager"));
  assert.ok(!keep("Junior Project Manager High-Voltage Cables"));
  assert.ok(!keep("Project Manager Construction"));
  assert.ok(!keep("Senior Java Developer"));
});

test("LinkedIn guest search and detail parse", () => {
  const jobs = parseLinkedInSearch(fixture("linkedin-search.html"));
  assert.equal(jobs.length, 10);
  assert.match(jobs[0].url, /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+\/$/);
  assert.ok(jobs.every((j) => j.title && j.company));
  const detail = parseLinkedInDetail(fixture("linkedin-detail.html"));
  assert.ok((detail.description ?? "").length > 1000);
  assert.equal(detail.employmentType, "Full-time");
});

test("Himalayas and Jobicy JSON parse", () => {
  const h = parseHimalayas(JSON.parse(fixture("himalayas.json")));
  assert.equal(h.length, 3);
  assert.ok(h[0].description && h[0].datePosted);
  const j = parseJobicy(JSON.parse(fixture("jobicy.json")));
  assert.equal(j.length, 3);
  assert.ok(j[0].description);
});

test("profile comes from --profile, then JH_PROFILE, then defaultProfile, with limit overrides", async () => {
  const { loadConfig, PATHS } = await import("../src/config.ts");
  assert.equal(loadConfig(PATHS.config, [], {}).profileName, "nuc-ollama");
  const mac = loadConfig(PATHS.config, [], { JH_PROFILE: "mac-mlx" });
  assert.equal(mac.profile.provider, "mac-mlx");
  assert.equal(mac.limits.maxNewJobsPerRun, 150);
  assert.equal(mac.limits.detailDelayMs, 2500);
  assert.equal(loadConfig(PATHS.config, ["--profile=nuc-ollama"], { JH_PROFILE: "mac-mlx" }).profileName, "nuc-ollama");
  assert.throws(() => loadConfig(PATHS.config, [], { JH_PROFILE: "nope" }), /unknown profile/);
});

test("PI_BIN pointing at a .js file runs through node, no shell", async () => {
  const { resolvePi } = await import("../src/llm.ts");
  const pi = resolvePi({ PI_BIN: "C:\\Users\\Me Too\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" });
  assert.equal(pi.command, process.execPath);
  assert.equal(pi.args.length, 1);
});
