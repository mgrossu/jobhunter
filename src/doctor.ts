import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { loadConfig, PATHS } from "./config.ts";
import { chat, listServerModels, readEndpoint, resolvePi, type Endpoint } from "./llm.ts";

// Checks one machine's setup end to end. `--context` also proves the server really uses the
// configured context window (slow on CPU: it sends a prompt of ~70% of contextTokens).

let failed = false;
const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const warn = (msg: string) => console.log(`  ! ${msg}`);
const fail = (msg: string) => { failed = true; console.log(`  ✖ ${msg}`); };

const config = loadConfig();
const { profile } = config;
console.log(`jobhunter doctor — profile "${config.profileName}": ${profile.provider} / ${profile.model}\n`);

const [major, minor] = process.versions.node.split(".").map(Number);
if (major > 22 || (major === 22 && minor >= 18)) ok(`node ${process.versions.node}`);
else fail(`node ${process.versions.node}: need 22.18 or newer (runs .ts files directly)`);

try {
  const pi = resolvePi();
  const version = spawnSync(pi.command, [...pi.args, "--version"], { encoding: "utf8", timeout: 60_000, windowsHide: true });
  if (version.status === 0) ok(`pi ${version.stdout.trim()} via ${pi.description}`);
  else fail(`pi did not run (${pi.description}): ${(version.stderr || String(version.error)).trim().slice(0, 200)}`);
} catch (error) {
  fail((error as Error).message);
}

let endpoint: Endpoint | null = null;
try {
  endpoint = readEndpoint(profile);
  ok(`pi models.json: provider "${profile.provider}" → ${endpoint.baseUrl}`);
  if (!endpoint.modelListed) fail(`pi models.json has no model with id "${profile.model}" under "${profile.provider}"`);
} catch (error) {
  fail((error as Error).message);
}

if (endpoint) {
  try {
    const served = await listServerModels(endpoint);
    // Ollama reports "name:latest"; requests without the tag work the same.
    if (served.some((id) => id === profile.model || id === `${profile.model}:latest`)) ok(`server is up and serves ${profile.model}`);
    else warn(`server is up but /models doesn't list ${profile.model} (lists: ${served.slice(0, 6).join(", ") || "nothing"}); some servers load on demand`);

    const tools = [{ type: "function", function: { name: "record_answer", description: "Record the answer.", parameters: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } }];
    const result = await chat(endpoint, profile.model, {
      messages: [{ role: "user", content: "What colour is a clear daytime sky? Reply only by calling record_answer." }],
      tools, max_tokens: 300,
    }, profile.timeoutMinutes * 60_000);
    const speed = result.completionTokens ? ` (${(result.completionTokens / result.seconds).toFixed(1)} tok/s incl. prompt)` : "";
    if (result.toolCalls[0]?.name === "record_answer") ok(`tool calling works: record_answer(${result.toolCalls[0].arguments}) in ${result.seconds.toFixed(1)} s${speed}`);
    else fail(`no tool call returned; the nightly run needs OpenAI-style tool calls. Model said: "${result.content.slice(0, 160)}"`);
    if (/<think>/.test(result.content)) warn("the model is emitting <think> blocks; use a non-thinking (instruct) model or disable thinking on the server");
  } catch (error) {
    fail(`server check failed: ${(error as Error).message}`);
  }

  if (process.argv.includes("--context")) {
    const target = Math.floor(profile.contextTokens * 0.7);
    const filler = Array.from({ length: Math.ceil(target / 12) }, (_, i) => `Line ${i}: the project status report lists routine milestones and nothing unusual.`).join("\n");
    const code = `PRAGUE-${Math.floor(1000 + Math.random() * 9000)}`;
    console.log(`  … context test: ~${target} tokens, this can take several minutes on CPU`);
    try {
      const result = await chat(endpoint, profile.model, {
        messages: [{ role: "user", content: `The secret code is ${code}. Remember it.\n\n${filler}\n\nWhat is the secret code given at the very beginning? Answer with the code only.` }],
        max_tokens: 30,
      }, Math.max(30, profile.timeoutMinutes) * 60_000);
      const seen = result.promptTokens ? `; server saw ${result.promptTokens} prompt tokens` : "";
      if (result.content.includes(code)) ok(`context holds ~${target} tokens (${result.seconds.toFixed(0)} s${seen})`);
      else fail(`the start of a ~${target}-token prompt was lost${seen}. The server's context is smaller than contextTokens=${profile.contextTokens}. On Ollama, use the Modelfile in deploy/windows.`);
    } catch (error) {
      fail(`context test failed: ${(error as Error).message}`);
    }
  }
}

const pandoc = spawnSync("pandoc", ["--version"], { encoding: "utf8", windowsHide: true });
if (pandoc.status === 0) ok(`pandoc ${pandoc.stdout.split("\n")[0].replace("pandoc ", "")} (for cv.docx)`);
else warn("pandoc not found: tailored CVs will be .html/.md only, no .docx");

if (existsSync(PATHS.baseCv) && existsSync(PATHS.preferences)) ok("approved CV and preferences present");
else warn("no data/cv.base.json or data/preferences.json yet; run /jh-setup in pi");

console.log(failed ? "\nSome checks failed." : "\nAll required checks passed.");
process.exitCode = failed ? 1 : 0;
