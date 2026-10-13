import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "./config.ts";
import { cvCorpus, type BaseCv } from "./cv.ts";
import type { Job } from "./store.ts";

/** What the model submits: a selection and light rewording of the approved CV, never new facts. */
export interface TailoredCv {
  headline: string;
  summary: string;
  skills: string[];
  experience: Array<{ id: string; bullets: Array<{ id: string; text: string }> }>;
  keywordsCovered: string[];
}

const NUMBER = /\d+(?:[.,]\d+)?/g;

/**
 * Words that name things (tools, companies, certifications, acronyms) rather than ordinary prose:
 * mixed case like "SAFe", all caps like "SAP", digits/symbols like "S/4HANA" or "C#",
 * and capitalised words that are not the first word of a sentence.
 */
export function namedTerms(text: string): string[] {
  const terms = new Set<string>();
  for (const sentence of text.split(/(?<=[.!?;:])\s+|\n+|\s+[–—-]\s+/)) {
    const words = sentence.split(/\s+/).map((w) => w.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, "")).filter(Boolean);
    words.forEach((word, index) => {
      if (word.length < 2) return;
      const inner = /[A-Z]/.test(word.slice(1));
      const symbolic = /[A-Za-z]/.test(word) && /[\d#+/&]/.test(word);
      const proper = index > 0 && /^[A-Z][a-z]/.test(word);
      if (inner || symbolic || proper) terms.add(word);
    });
  }
  return [...terms];
}

function numbers(text: string): string[] {
  return (text.match(NUMBER) ?? []).map((n) => n.replace(",", "."));
}

export function validateTailoring(t: TailoredCv, cv: BaseCv): string[] {
  const problems: string[] = [];
  const corpus = cvCorpus(cv);
  const corpusNumbers = new Set(numbers(corpus));
  const unknownTerms = (text: string) => namedTerms(text).filter((term) => !corpus.includes(term.toLowerCase()));

  for (const [field, text] of [["headline", t.headline], ["summary", t.summary]] as const) {
    if (!text?.trim()) { problems.push(`${field} is empty`); continue; }
    const bad = unknownTerms(text);
    if (bad.length) problems.push(`${field} names things not in the CV: ${bad.join(", ")}. Use only tools, companies and certifications the CV contains.`);
    const badNumbers = numbers(text).filter((n) => !corpusNumbers.has(n));
    if (badNumbers.length) problems.push(`${field} uses numbers not in the CV: ${badNumbers.join(", ")}`);
  }
  if (t.summary && t.summary.length > 900) problems.push("summary is too long; keep it under ~120 words");

  const baseSkills = new Map(cv.skills.map((s) => [s.toLowerCase(), s]));
  const strangers = (t.skills ?? []).filter((s) => !baseSkills.has(s.toLowerCase()));
  if (strangers.length) problems.push(`skills not in the CV: ${strangers.join(", ")}. Choose and order skills from the CV's list only.`);
  if (!t.skills?.length) problems.push("skills is empty");

  const roles = new Map(cv.experience.map((r) => [r.id, r]));
  const seen = new Set<string>();
  for (const entry of t.experience ?? []) {
    const role = roles.get(entry.id);
    if (!role) { problems.push(`experience id ${entry.id} does not exist`); continue; }
    seen.add(entry.id);
    if (!entry.bullets?.length) problems.push(`${entry.id} needs at least one bullet`);
    for (const bullet of entry.bullets ?? []) {
      const original = role.bullets.find((b) => b.id === bullet.id);
      if (!original) { problems.push(`bullet ${bullet.id} does not belong to ${entry.id}`); continue; }
      const allowedNumbers = new Set(numbers(original.text));
      const badNumbers = numbers(bullet.text).filter((n) => !allowedNumbers.has(n));
      if (badNumbers.length) problems.push(`${bullet.id} adds numbers not in the original bullet: ${badNumbers.join(", ")}`);
      const bad = unknownTerms(bullet.text);
      if (bad.length) problems.push(`${bullet.id} names things not in the CV: ${bad.join(", ")}`);
      if (bullet.text.length > original.text.length * 1.6 + 40) problems.push(`${bullet.id} is much longer than the original; reword, don't expand`);
    }
  }
  const missing = cv.experience.filter((r) => !seen.has(r.id)).map((r) => r.id);
  if (missing.length) problems.push(`every role must stay on the CV (no timeline gaps); missing: ${missing.join(", ")}`);
  return problems;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

/** Roles in original (chronological) order, with the model's bullet selection and order. */
function assemble(t: TailoredCv, cv: BaseCv) {
  const chosen = new Map(t.experience.map((e) => [e.id, e.bullets]));
  return cv.experience.map((role) => ({ ...role, bullets: chosen.get(role.id) ?? role.bullets }));
}

export function renderMarkdown(t: TailoredCv, cv: BaseCv): string {
  const c = cv.contact;
  const lines = [
    `# ${cv.name}`, "", `**${t.headline}**`, "",
    [c.location, c.email, c.phone, c.linkedin, c.website].filter(Boolean).join(" · "), "",
    "## Profile", "", t.summary, "",
    "## Core skills", "", t.skills.join(" · "), "",
    "## Experience", "",
  ];
  for (const role of assemble(t, cv)) {
    lines.push(`### ${role.role} — ${role.company}`, "", `*${role.start} – ${role.end}${role.engagement ? ` · ${role.engagement}` : ""}${role.location ? ` · ${role.location}` : ""}*`, "");
    for (const b of role.bullets) lines.push(`- ${b.text}`);
    lines.push("");
  }
  if (cv.certifications.length) lines.push("## Certifications", "", ...cv.certifications.map((x) => `- ${x}`), "");
  if (cv.education.length) lines.push("## Education", "", ...cv.education.map((e) => `- ${e.degree}, ${e.institution}${e.year ? ` (${e.year})` : ""}`), "");
  if (cv.languages.length) lines.push("## Languages", "", cv.languages.map((l) => `${l.language} (${l.level})`).join(" · "), "");
  return lines.join("\n");
}

export function renderHtml(t: TailoredCv, cv: BaseCv): string {
  const c = cv.contact;
  const roles = assemble(t, cv).map((role) => `
    <section class="role">
      <div class="role-head"><h3>${esc(role.role)} — ${esc(role.company)}</h3><span>${esc(role.start)} – ${esc(role.end)}</span></div>
      ${role.engagement || role.location ? `<div class="meta">${esc([role.engagement, role.location].filter(Boolean).join(" · "))}</div>` : ""}
      <ul>${role.bullets.map((b) => `<li>${esc(b.text)}</li>`).join("")}</ul>
    </section>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(cv.name)} — CV</title>
<style>
  @page { size: A4; margin: 16mm 15mm; }
  body { font: 10.5pt/1.45 "Helvetica Neue", Arial, sans-serif; color: #1d1d1f; max-width: 780px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 22pt; margin: 0; letter-spacing: -0.01em; }
  .headline { font-size: 12pt; color: #2457a6; margin: 2px 0 6px; font-weight: 600; }
  .contact { color: #555; font-size: 9.5pt; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.08em; color: #2457a6; border-bottom: 1px solid #d8dde6; padding-bottom: 3px; margin: 18px 0 8px; }
  h3 { font-size: 10.5pt; margin: 0; }
  .role { margin-bottom: 10px; break-inside: avoid; }
  .role-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
  .role-head span, .meta { color: #666; font-size: 9.5pt; white-space: nowrap; }
  ul { margin: 4px 0 0; padding-left: 18px; } li { margin: 2px 0; }
  .skills { line-height: 1.7; }
  @media print { body { margin: 0; padding: 0; } }
</style></head><body>
  <h1>${esc(cv.name)}</h1>
  <div class="headline">${esc(t.headline)}</div>
  <div class="contact">${esc([c.location, c.email, c.phone, c.linkedin, c.website].filter(Boolean).join(" · "))}</div>
  <h2>Profile</h2><p>${esc(t.summary)}</p>
  <h2>Core skills</h2><p class="skills">${t.skills.map(esc).join(" · ")}</p>
  <h2>Experience</h2>${roles}
  ${cv.certifications.length ? `<h2>Certifications</h2><ul>${cv.certifications.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
  ${cv.education.length ? `<h2>Education</h2><ul>${cv.education.map((e) => `<li>${esc(`${e.degree}, ${e.institution}${e.year ? ` (${e.year})` : ""}`)}</li>`).join("")}</ul>` : ""}
  ${cv.languages.length ? `<h2>Languages</h2><p>${cv.languages.map((l) => esc(`${l.language} (${l.level})`)).join(" · ")}</p>` : ""}
</body></html>
`;
}

/** Writes cv.html, cv.md, cv.docx (if pandoc is installed) and the posting next to them. */
export function writeTailoredFiles(job: Job, t: TailoredCv, cv: BaseCv): { dir: string; files: string[] } {
  const dir = join(PATHS.out, `${new Date().toISOString().slice(0, 10)}_${slug(job.company ?? "company")}_${slug(job.title)}_${job.id.slice(0, 6)}`);
  mkdirSync(dir, { recursive: true });
  const md = renderMarkdown(t, cv);
  const files = [join(dir, "cv.html"), join(dir, "cv.md"), join(dir, "posting.md")];
  writeFileSync(files[0], renderHtml(t, cv));
  writeFileSync(files[1], md);
  writeFileSync(files[2], `# ${job.title} — ${job.company ?? ""}\n\n${job.location ?? ""} · ${job.employmentType ?? ""}\n\nSource: ${job.attribution} — ${job.url}\n\n${job.description ?? ""}\n`);
  const docx = join(dir, "cv.docx");
  const pandoc = spawnSync("pandoc", [files[1], "-o", docx], { timeout: 60_000 });
  if (pandoc.status === 0) files.push(docx);
  return { dir, files };
}
