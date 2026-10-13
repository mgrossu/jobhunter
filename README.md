# jobhunter

An overnight job search for IT project-management **contract (B2B / IČO / freelance)** roles in **Prague and remote EU**. It is driven by the [pi coding agent](https://pi.dev) and runs on a local model. It works on **Windows, Linux and macOS** with any OpenAI-compatible model server: Ollama, an MLX server, LM Studio, llama.cpp or vLLM.

Each night it:

1. **Fetches** new postings from LinkedIn (public guest search with contract/remote filters), Jobs.cz, freelancermap, Himalayas and Jobicy, keeps PM/delivery titles, and dedupes across boards.
2. **Scores** each posting against your approved CV. The model lists the posting's requirements and marks each one met, partial or gap, citing CV evidence ids. The **match % is computed by code**, not guessed by the model. Contract, location and language gates can veto a job.
3. **Tailors your CV** for every job at **≥ 90%**. It only selects, reorders and lightly rewords your CV's own bullets; a validator rejects any tool, number, company or skill that isn't in your CV.
4. **Writes a morning report**: `reports/latest.html` (plus `.md`), with an optional push notification.

In the morning you run `/jh-review` in pi. You pick a job, confirm in a dialog, and it opens the apply page and the tailored CV folder. **You submit yourself.** Nothing is ever sent automatically.

```
nightly.ts ── fetch (plain code, polite HTTP) ──▶ .jobhunter/jobs/*.json
    │
    ├─ per job:       node pi/cli.js -p --tools jh_record_score      ──▶ model server (OpenAI API)
    │                 CV + posting via stdin, system prompt via file; invalid answers go back to the model
    ├─ per ≥90% job:  node pi/cli.js -p --tools jh_save_tailored_cv  ──▶ out/<date>_<company>_<title>/cv.{html,md,docx}
    └─ report ──▶ reports/latest.html  (+ ntfy push)

morning: pi → /jh-review → confirm dialog → apply page opens → you submit → jh_mark applied
```

Each pi call gets one job and exactly one tool. Short, bounded calls like this are much more reliable on a 3B-active local model than one long agentic session. The CV comes first in every prompt, so servers with prompt caching only process the posting fresh.

## Profiles: one config, several machines

`config/jobhunter.json` has a `profiles` section. The active profile is chosen by `--profile=<name>`, then `JH_PROFILE`, then `defaultProfile`.

| Profile | Machine | Model server | Model |
|---|---|---|---|
| `nuc-ollama` (default) | Windows 11 NUC, CPU only | Ollama, `127.0.0.1:11434` | `qwen3:30b-a3b-instruct-2507-q4_K_M` wrapped as `jobhunter-qwen` with a 16k context |
| `mac-mlx` | Linux container (or the Mac itself) | MLX server on the Mac, `:8080` | `mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit` |

Both use a **non-thinking instruct** model on purpose. Ollama and the various MLX servers each switch "thinking" off in their own way, and on CPU the thinking tokens would cost hours.

A profile names a pi provider and model. The server **address** lives in that machine's pi `models.json` (`deploy/pi-models/*.json` are ready-made); the container writes it from `JH_LLM_BASE_URL`. A profile can also override `limits`, so the Mac takes 150 jobs a night where the NUC takes 60.

## Setup A: Windows 11 NUC with Ollama

Install Node 24 LTS, Ollama and pandoc (`winget install OpenJS.NodeJS.LTS Ollama.Ollama JohnMacFarlane.Pandoc`). Then, in PowerShell from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File deploy\windows\install.ps1     # -RunAt 01:00 to change the time
npm run doctor -- --context
```

`install.ps1` does the following:

- installs pi and the npm dependencies;
- copies `deploy\pi-models\ollama.json` to `%USERPROFILE%\.pi\agent\models.json` (if that file already exists, it tells you to merge instead);
- pulls the model and runs `ollama create jobhunter-qwen -f deploy\windows\Modelfile`;
- registers the **`jobhunter-nightly`** scheduled task.

**Why the Modelfile matters:** Ollama defaults to a **4k context** on machines without a large GPU, which would silently cut off the CV-plus-posting prompt. The Modelfile pins 16k. `doctor --context` proves it by checking that a marker at the start of a long prompt is still seen.

The task runs while you're signed in, because Ollama's tray app runs per user. Keep the NUC signed in (locked is fine) and enable "Allow wake timers" in the power plan so `WakeToRun` can wake it.

## Setup B: Linux container, with the model server on the Mac

**On the Mac**, run an OpenAI-compatible MLX server, for example:

```bash
pip install mlx-lm       # or: uv tool install mlx-lm
mlx_lm.server --model mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit --host 127.0.0.1 --port 8080
# keep it running across reboots:
cp deploy/mac/com.jobhunter.mlx-server.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.jobhunter.mlx-server.plist
```

The nightly run needs **OpenAI-style tool calls**. `npm run doctor` tests exactly that. If your `mlx_lm.server` version doesn't return `tool_calls`, use an MLX server that does, such as LM Studio's MLX engine (port 1234) or vllm-mlx with `--enable-auto-tool-choice --tool-call-parser`. Then set that URL and model id. `mlx_lm.server` has no authentication: keep it on `127.0.0.1` if the container runs on the same Mac, and expose it only on a trusted LAN otherwise.

**The container** (on the Mac with Docker Desktop, or on any Linux host):

```bash
# compose.yaml: set JH_LLM_BASE_URL (same Mac: http://host.docker.internal:8080/v1, other host: http://<mac-ip>:8080/v1)
docker compose build
docker compose run --rm jobhunter npm run doctor -- --context
docker compose run --rm -it jobhunter pi          # /jh-setup once, /jh-review each morning
docker compose up -d                               # nightly at JH_RUN_AT (container time, TZ=Europe/Prague)
```

`config/`, `data/`, `.jobhunter/`, `out/`, `reports/` and `logs/` are bind-mounted, so the reports and tailored CVs land in this folder on the host. Inside the container the apply page can't open a browser; `/jh-review` prints the URL instead.

## Setup C: anything else

On any OS with Node ≥ 22.18 and pi: add your server to pi's `models.json` (copy a file from `deploy/pi-models/`), add or edit a profile, then run `npm run doctor`. For scheduling, use cron, launchd or Task Scheduler with `node src/nightly.ts --profile=<name>`, or keep `npm run schedule` running.

## First run (every setup)

1. Put your CV (`CV.docx` or `CV.pdf`) in `data/`, start `pi`, and run **`/jh-setup`**. It turns the CV into `data/cv.base.json` (roles `e1…`, bullets `e1.b1…`, copied verbatim) and asks for your preferences: contract types, whether employment is acceptable, home base, remote regions, onsite cities, minimum day rate and dealbreakers. You review and confirm before anything is saved. Every tailored CV is built only from this file. A stronger model is fine for this one-off step.
2. `npm run fetch` does a live fetch only, so you can see what each source returns.
3. `npm run nightly -- --no-fetch` scores and tailors what was fetched; `reports/latest.html` shows the result.
4. Check `logs/nightly-<date>.log` for minutes per job, then tune `limits` in your profile.

## Commands

| Command | What it does |
|---|---|
| `npm run doctor [-- --context]` | Checks Node, pi, `models.json`, the server, tool calling, real context size, pandoc and your profile files |
| `npm run nightly [-- --profile=x] [-- --no-fetch]` | One full run |
| `npm run schedule [-- --now]` | Runs nightly every day at `JH_RUN_AT` (used by the container) |
| `npm run fetch` / `npm run report` / `npm run status` | Fetch only, regenerate the report, list open matches |
| `pi "/jh-review"` | Morning review and confirm-then-open |
| `npm test` | Unit tests |

## Tuning

| Key in `config/jobhunter.json` | What it does |
|---|---|
| `threshold` / `nearMiss` | 90 / 80. Near misses are reported but not tailored. |
| `profiles.<name>` | Provider, model, thinking levels, per-job timeout, `contextTokens` (postings that wouldn't fit are skipped, not truncated), per-profile `limits` |
| `searches` | Source, keywords, location, `contract`, `remote`, `maxAgeDays` |
| `titleInclude` / `titleExclude` | Regexes applied before detail pages are fetched; the cheapest place to cut noise |
| `notify.ntfyUrl` | An [ntfy](https://ntfy.sh) topic for a one-line summary on your phone. Use a long random topic. It never sends CV content. |

## Honest limitations

- **The 90% is only as good as the model's reading.** Evidence must point at real CV entries, so the model can't invent fit, but a 30B MoE will still sometimes be generous or harsh. Watch the near misses during the first week.
- **LinkedIn's contract filter is loose.** Many results are marked "Full-time" on the detail page. The contract gate catches clear employment-only roles; unclear ones show as FLAG.
- **LinkedIn guest endpoints** are public but unofficial, and their terms discourage automated access. Volume is small (six searches and a few dozen detail pages a night, 2.5 s apart). Delete those searches if you'd rather not take that risk.
- **Jobs.cz** detail pages often redirect to employer career sites, so their text is extracted generically.
- **Speed is an estimate.** A 2020 NUC on CPU should take roughly 2–4 minutes per job; an Apple Silicon Mac is several times faster. The logs show the real numbers.
- **The tailored CV** uses a clean, generic layout (`cv.html` for print-to-PDF, and `cv.docx` through pandoc), not your Word template.

## Where things live

| Path | Contents (all git-ignored) |
|---|---|
| `data/` | Your CV, `cv.base.json`, `preferences.json` |
| `.jobhunter/jobs/` | One JSON per job: posting, assessment, status history |
| `out/` | Tailored CVs, one folder per job, with the posting saved alongside |
| `reports/` | Nightly reports; `latest.html` is the newest |
| `logs/` | Nightly logs |

Design ideas such as grounded facts with evidence, deterministic gates, posting text treated as untrusted data, and no auto-submit come from [pi-job-search](https://github.com/sovorn-c/pi-job-search) and [Deviad/job-hunter](https://github.com/Deviad/job-hunter). Both are MIT-licensed; no code was copied.
