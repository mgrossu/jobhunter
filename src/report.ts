import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { PATHS, type Config } from "./config.ts";
import type { FetchSummary } from "./fetch.ts";
import { listJobs, type Job } from "./store.ts";

export interface RunStats {
  startedAt: string;
  finishedAt: string;
  fetch: FetchSummary | null;
  scored: number;
  scoreFailed: number;
  tailored: number;
  leftForNextRun: number;
  notes: string[];
}

const esc = (text: string | null | undefined) => (text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function gateBadge(label: string, gate: string | undefined, note: string | undefined): string {
  return `<span class="gate gate-${(gate ?? "na").toLowerCase()}" title="${esc(note)}">${label}: ${gate ?? "n/a"}</span>`;
}

function card(job: Job, config: Config): string {
  const s = job.score!;
  const met = s.requirements.filter((r) => r.status === "met" && r.importance === "must").map((r) => r.text);
  const gaps = s.requirements.filter((r) => r.status !== "met").map((r) => `${r.text} (${r.importance}, ${r.status})`);
  const cvLink = job.tailored ? `<a href="${esc(relative(PATHS.reports, join(job.tailored.dir, "cv.html")).split(sep).join("/"))}">tailored CV</a>` : "<em>CV not tailored yet</em>";
  return `
  <article class="job">
    <header>
      <div class="pct ${s.matchPercent >= config.threshold ? "hi" : "mid"}">${s.matchPercent}%</div>
      <div><h3><a href="${esc(job.url)}">${esc(job.title)}</a></h3>
      <div class="meta">${esc(job.company)} · ${esc(job.location)} · ${esc(job.employmentType)} · via ${esc(job.attribution)}${s.dayRate ? ` · rate: ${esc(s.dayRate)}` : ""}</div></div>
    </header>
    <p>${esc(s.summary)}</p>
    <div class="gates">${gateBadge("Contract", s.contractGate, s.contractNote)}${gateBadge("Location", s.locationGate, s.locationNote)}${gateBadge("Language", s.languageGate, s.languageNote)}</div>
    ${met.length ? `<details open><summary>Must-haves you meet (${met.length})</summary><ul>${met.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></details>` : ""}
    ${gaps.length ? `<details><summary>Gaps &amp; partials (${gaps.length})</summary><ul>${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></details>` : ""}
    ${s.redFlags.length ? `<p class="flags">⚠ ${s.redFlags.map(esc).join(" · ")}</p>` : ""}
    <footer>${cvLink} · id <code>${job.id}</code> · apply: <code>pi "/jh-review ${job.id}"</code></footer>
  </article>`;
}

export function buildReport(config: Config, stats: RunStats): { html: string; markdown: string; headline: string } {
  const scored = listJobs((j) => Boolean(j.score) && j.status !== "applied" && j.status !== "skipped");
  const byScore = (a: Job, b: Job) => b.score!.matchPercent - a.score!.matchPercent;
  const shortlist = scored.filter((j) => j.score!.verdict === "shortlist").sort(byScore);
  const near = scored.filter((j) => j.score!.verdict === "near-miss").sort(byScore);
  const freshCutoff = stats.startedAt;
  const newShort = shortlist.filter((j) => j.score!.scoredAt >= freshCutoff);
  const headline = `${newShort.length} new match${newShort.length === 1 ? "" : "es"} ≥${config.threshold}% (${shortlist.length} open in total), ${near.length} near-misses`;
  const f = stats.fetch;

  const markdown = [
    `# Job hunt report — ${stats.finishedAt.slice(0, 10)}`, "", `**${headline}**`, "",
    "## Matches", "",
    ...(shortlist.length ? shortlist.map((j) => `- **${j.score!.matchPercent}%** [${j.title}](${j.url}) — ${j.company ?? "?"}, ${j.location ?? "?"} · contract ${j.score!.contractGate}, location ${j.score!.locationGate} · ${j.tailored ? `CV: ${j.tailored.dir}` : "CV pending"} · \`${j.id}\``) : ["_None yet._"]),
    "", "## Near misses", "",
    ...(near.length ? near.map((j) => `- ${j.score!.matchPercent}% [${j.title}](${j.url}) — ${j.company ?? "?"} · \`${j.id}\``) : ["_None._"]),
    "", "## Run", "",
    `- Listed ${f?.listed ?? 0}, title-filtered ${f?.titleFiltered ?? 0}, already seen ${f?.alreadySeen ?? 0}, new stored ${f?.stored ?? 0}, deferred ${f?.deferred ?? 0}`,
    `- Scored ${stats.scored}, failed ${stats.scoreFailed}, tailored ${stats.tailored}, left for next run ${stats.leftForNextRun}`,
    ...(f?.failures ?? []).map((x) => `- Source problem: ${x.where}: ${x.error}`),
    ...stats.notes.map((n) => `- ${n}`), "",
  ].join("\n");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job hunt ${stats.finishedAt.slice(0, 10)}</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1d1d1f;--muted:#6b6b73;--line:#e3e3e8;--accent:#2457a6;--ok:#1f7a4d;--warn:#a86a00;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1e1e22;--fg:#ececf0;--muted:#a0a0aa;--line:#33333a;--accent:#7aa7ff;--ok:#5cc28f;--warn:#e0a53a;--bad:#ff8a80}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px}
main{max-width:860px;margin:0 auto} h1{margin:0 0 4px;font-size:24px} .lead{color:var(--muted);margin:0 0 24px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 10px}
.job{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.job header{display:flex;gap:14px;align-items:flex-start} .job h3{margin:0;font-size:16px} a{color:var(--accent)}
.pct{font-weight:700;font-size:18px;min-width:64px;text-align:center;border-radius:8px;padding:6px 0;background:var(--bg)}
.pct.hi{color:var(--ok)} .pct.mid{color:var(--warn)} .meta,.job footer{color:var(--muted);font-size:13px}
.gates{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0} .gate{font-size:12px;border:1px solid var(--line);border-radius:99px;padding:1px 8px}
.gate-pass{color:var(--ok)} .gate-flag{color:var(--warn)} .gate-fail{color:var(--bad)} .flags{color:var(--warn);font-size:13px}
details{font-size:14px;margin:4px 0} ul{margin:4px 0;padding-left:20px} code{font-size:12px}
.stats{font-size:13px;color:var(--muted)}
</style></head><body><main>
<h1>Job hunt — ${esc(stats.finishedAt.slice(0, 10))}</h1>
<p class="lead">${esc(headline)}</p>
<h2>Matches ≥ ${config.threshold}%</h2>
${shortlist.length ? shortlist.map((j) => card(j, config)).join("") : "<p>No matches yet. Near misses below may still be worth a look.</p>"}
<h2>Near misses ${config.nearMiss}–${config.threshold - 0.1}%</h2>
${near.length ? near.map((j) => card(j, config)).join("") : "<p>None.</p>"}
<h2>Run</h2>
<div class="stats"><pre>${esc(markdown.split("## Run")[1]?.trim())}</pre></div>
</main></body></html>`;
  return { html, markdown, headline };
}

export function writeReport(config: Config, stats: RunStats): { htmlPath: string; mdPath: string; headline: string } {
  mkdirSync(PATHS.reports, { recursive: true });
  const { html, markdown, headline } = buildReport(config, stats);
  const day = stats.finishedAt.slice(0, 10);
  const htmlPath = join(PATHS.reports, `${day}.html`);
  const mdPath = join(PATHS.reports, `${day}.md`);
  writeFileSync(htmlPath, html);
  writeFileSync(mdPath, markdown);
  copyFileSync(htmlPath, join(PATHS.reports, "latest.html"));
  copyFileSync(mdPath, join(PATHS.reports, "latest.md"));
  return { htmlPath, mdPath, headline };
}
