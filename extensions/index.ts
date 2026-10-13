import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import { loadConfig, PATHS } from "../src/config.ts";
import { loadBaseCv, validateBaseCv, type BaseCv, type Preferences } from "../src/cv.ts";
import { finalizeScore, validateScore, type ScoreInput } from "../src/score.ts";
import { listJobs, readJob, setStatus, writeJsonAtomic, type Job } from "../src/store.ts";
import { validateTailoring, writeTailoredFiles, type TailoredCv } from "../src/tailor.ts";

const gate = Type.Union([Type.Literal("PASS"), Type.Literal("FLAG"), Type.Literal("FAIL")]);

const scoreParams = Type.Object({
  jobId: Type.String(),
  requirements: Type.Array(Type.Object({
    text: Type.String(),
    importance: Type.Union([Type.Literal("must"), Type.Literal("nice")]),
    status: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("gap")]),
    evidence: Type.Array(Type.String(), { description: "CV ids: e2.b3, summary, skill:<name>, cert:<name>, lang:<language>, edu" }),
  })),
  contractGate: gate, contractNote: Type.String(),
  locationGate: gate, locationNote: Type.String(),
  languageGate: gate, languageNote: Type.String(),
  dayRate: Type.Union([Type.String(), Type.Null()]),
  summary: Type.String(),
  redFlags: Type.Array(Type.String()),
});

const tailorParams = Type.Object({
  jobId: Type.String(),
  headline: Type.String(),
  summary: Type.String(),
  skills: Type.Array(Type.String()),
  experience: Type.Array(Type.Object({
    id: Type.String({ description: "role id from the CV, e.g. e1" }),
    bullets: Type.Array(Type.Object({ id: Type.String({ description: "bullet id, e.g. e1.b2" }), text: Type.String() })),
  })),
  keywordsCovered: Type.Array(Type.String()),
});

const baseCvParams = Type.Object({
  name: Type.String(), headline: Type.String(),
  contact: Type.Object({
    email: Type.Optional(Type.String()), phone: Type.Optional(Type.String()), location: Type.Optional(Type.String()),
    linkedin: Type.Optional(Type.String()), website: Type.Optional(Type.String()),
  }),
  summary: Type.String(),
  skills: Type.Array(Type.String()),
  experience: Type.Array(Type.Object({
    id: Type.String(), company: Type.String(), role: Type.String(), start: Type.String(), end: Type.String(),
    location: Type.Optional(Type.String()), engagement: Type.Optional(Type.String()),
    bullets: Type.Array(Type.Object({ id: Type.String(), text: Type.String() })),
  })),
  education: Type.Array(Type.Object({ institution: Type.String(), degree: Type.String(), year: Type.Optional(Type.String()) })),
  certifications: Type.Array(Type.String()),
  languages: Type.Array(Type.Object({ language: Type.String(), level: Type.String() })),
});

const prefsParams = Type.Object({
  targetRoles: Type.Array(Type.String()),
  contractTypes: Type.Array(Type.String()),
  acceptEmployment: Type.Boolean(),
  homeBase: Type.String(),
  remoteRegions: Type.Array(Type.String()),
  onsiteCities: Type.Array(Type.String()),
  minDayRateEur: Type.Optional(Type.Number()),
  dealbreakers: Type.Array(Type.String()),
  notes: Type.Optional(Type.String()),
});

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: undefined };
}

/** Nightly runs pin each pi process to one job, so a confused model cannot write to another. */
function guardJob(jobId: string): void {
  const expected = process.env.JH_EXPECTED_JOB;
  if (expected && expected !== jobId) throw new Error(`This run is for job ${expected}; you passed ${jobId}.`);
}

function brief(job: Job) {
  return {
    id: job.id, status: job.status, title: job.title, company: job.company, location: job.location,
    employmentType: job.employmentType, match: job.score?.matchPercent, verdict: job.score?.verdict,
    gates: job.score && { contract: job.score.contractGate, location: job.score.locationGate, language: job.score.languageGate },
    dayRate: job.score?.dayRate, summary: job.score?.summary, url: job.url, source: job.attribution,
    tailoredCv: job.tailored?.files,
  };
}

function openExternal(target: string): boolean {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false;
  try {
    spawn(opener, [target], { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

export default function register(pi: ExtensionAPI) {
  // ------------------------------------------------------------ nightly (non-interactive)

  pi.registerTool({
    name: "jh_record_score",
    label: "Record job score",
    description: "Record your requirement-by-requirement assessment of one job against the candidate CV. The match percentage is computed from your statuses (must=2, nice=1; met=1, partial=0.5, gap=0). Rejected submissions list the problems to fix.",
    parameters: scoreParams,
    async execute(_id, params) {
      guardJob(params.jobId);
      const { jobId, ...input } = params as typeof params & ScoreInput;
      const cv = loadBaseCv();
      const problems = validateScore(input, cv);
      if (problems.length) throw new Error(`Not recorded. Fix and call again:\n- ${problems.join("\n- ")}`);
      const config = loadConfig();
      const job = readJob(jobId);
      job.score = finalizeScore(input, config.threshold, config.nearMiss, process.env.JH_MODEL_LABEL ?? "interactive");
      setStatus(job, job.score.verdict === "shortlist" ? "shortlisted" : "scored", `${job.score.matchPercent}% ${job.score.verdict}`);
      return text(`Recorded: ${job.score.matchPercent}% (${job.score.verdict}).`);
    },
  });

  pi.registerTool({
    name: "jh_save_tailored_cv",
    label: "Save tailored CV",
    description: "Save a tailored CV for one shortlisted job. It must be a selection and light rewording of the approved CV; anything not in the CV is rejected with the reason.",
    parameters: tailorParams,
    async execute(_id, params) {
      guardJob(params.jobId);
      const { jobId, ...tailoring } = params as typeof params & TailoredCv;
      const cv = loadBaseCv();
      const problems = validateTailoring(tailoring, cv);
      if (problems.length) throw new Error(`Not saved. Fix and call again:\n- ${problems.join("\n- ")}`);
      const job = readJob(jobId);
      const written = writeTailoredFiles(job, tailoring, cv);
      job.tailored = { ...tailoring, ...written };
      setStatus(job, "tailored");
      return text(`Saved tailored CV: ${written.files.join(", ")}`);
    },
  });

  // ------------------------------------------------------------ setup (interactive)

  pi.registerTool({
    name: "jh_save_base_cv",
    label: "Save approved base CV",
    description: "Save the structured, user-approved CV to data/cv.base.json. Ids: roles e1, e2 ... newest first; bullets e1.b1, e1.b2 ... Asks the user to confirm before writing.",
    parameters: baseCvParams,
    async execute(_id, params, _signal, _update, ctx) {
      const cv = params as BaseCv;
      const problems = validateBaseCv(cv);
      if (problems.length) throw new Error(`Not saved:\n- ${problems.join("\n- ")}`);
      if (!ctx.hasUI) throw new Error("Saving the base CV needs an interactive session so the user can confirm.");
      const bullets = cv.experience.reduce((n, r) => n + r.bullets.length, 0);
      const ok = await ctx.ui.confirm("Save approved CV?", `${cv.name}: ${cv.experience.length} roles, ${bullets} bullets, ${cv.skills.length} skills → data/cv.base.json`);
      if (!ok) return text("User declined; nothing written.");
      writeJsonAtomic(PATHS.baseCv, cv);
      return text(`Saved ${PATHS.baseCv}`);
    },
  });

  pi.registerTool({
    name: "jh_save_preferences",
    label: "Save search preferences",
    description: "Save the user's contract, location, rate and dealbreaker preferences to data/preferences.json after they confirm.",
    parameters: prefsParams,
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("Saving preferences needs an interactive session so the user can confirm.");
      const prefs = params as Preferences;
      const ok = await ctx.ui.confirm("Save preferences?", JSON.stringify(prefs, null, 2));
      if (!ok) return text("User declined; nothing written.");
      writeJsonAtomic(PATHS.preferences, prefs);
      return text(`Saved ${PATHS.preferences}`);
    },
  });

  // ------------------------------------------------------------ morning review (interactive)

  pi.registerTool({
    name: "jh_list_matches",
    label: "List matched jobs",
    description: "List open matches (shortlisted/tailored) and near misses from the nightly runs, best first.",
    parameters: Type.Object({ includeNearMisses: Type.Optional(Type.Boolean()) }),
    async execute(_id, params) {
      const open = listJobs((j) => ["shortlisted", "tailored", "applying"].includes(j.status) || (Boolean(params.includeNearMisses) && j.score?.verdict === "near-miss" && j.status === "scored"));
      open.sort((a, b) => (b.score?.matchPercent ?? 0) - (a.score?.matchPercent ?? 0));
      return text(open.length ? open.map(brief) : "No open matches. Check reports/latest.html for the last run.");
    },
  });

  pi.registerTool({
    name: "jh_get_job",
    label: "Get job details",
    description: "Full stored record for one job: posting text, requirement-by-requirement assessment and tailored CV paths.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params) {
      const job = readJob(params.jobId);
      return text({ ...brief(job), requirements: job.score?.requirements, redFlags: job.score?.redFlags, notes: { contract: job.score?.contractNote, location: job.score?.locationNote, language: job.score?.languageNote }, description: job.description });
    },
  });

  pi.registerTool({
    name: "jh_open_application",
    label: "Open application",
    description: "After the user decides to apply: shows them a confirmation dialog, then opens the job's apply page and the tailored CV folder so they can submit themselves. Never submits anything.",
    parameters: Type.Object({ jobId: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("Opening an application needs an interactive session so the user can confirm.");
      const job = readJob(params.jobId);
      const cvFile = job.tailored?.files.find((f) => f.endsWith(".docx")) ?? job.tailored?.files.find((f) => f.endsWith(".html"));
      const ok = await ctx.ui.confirm(
        `Apply to ${job.title}?`,
        `${job.company ?? ""} · ${job.score?.matchPercent ?? "?"}% match\nApply page: ${job.applyUrl ?? job.url}\nCV: ${cvFile ?? "not tailored — base CV"}\n\nThis opens the page; you review and submit yourself.`,
      );
      if (!ok) return text("User cancelled; nothing opened.");
      const openedPage = openExternal(job.applyUrl ?? job.url);
      const openedDir = job.tailored ? openExternal(job.tailored.dir) : false;
      setStatus(job, "applying");
      return text({
        status: "applying",
        applyUrl: job.applyUrl ?? job.url,
        cv: cvFile,
        opened: { page: openedPage, cvFolder: openedDir },
        next: "After submitting, call jh_mark with status applied. If the user changes their mind, mark skipped.",
      });
    },
  });

  pi.registerTool({
    name: "jh_mark",
    label: "Mark job",
    description: "Record the user's decision on a job: applied (they submitted) or skipped (not interested). Use only on the user's explicit word.",
    parameters: Type.Object({ jobId: Type.String(), status: Type.Union([Type.Literal("applied"), Type.Literal("skipped")]), note: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      const job = readJob(params.jobId);
      setStatus(job, params.status, params.note);
      return text(`${job.title} marked ${params.status}.`);
    },
  });
}
