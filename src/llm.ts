import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { PATHS, type Profile } from "./config.ts";

/** How to launch pi without a shell: a command plus leading args. */
export interface PiCommand {
  command: string;
  args: string[];
  description: string;
}

function nodeScript(path: string): PiCommand {
  return { command: process.execPath, args: [path], description: `node ${path}` };
}

/**
 * Finds pi's JavaScript entry so it can be run with `node` directly. This avoids the
 * `pi.cmd` shim on Windows, which Node cannot spawn without a shell, and a shell would
 * mangle arguments that contain spaces.
 */
export function resolvePi(env = process.env): PiCommand {
  const explicit = env.PI_BIN;
  if (explicit) return [".js", ".mjs", ".cjs"].includes(extname(explicit)) ? nodeScript(explicit) : { command: explicit, args: [], description: explicit };
  const npm = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", timeout: 30_000 });
  const globalRoot = npm.status === 0 ? npm.stdout.trim() : null;
  if (globalRoot) {
    const pkgDir = join(globalRoot, "@earendil-works", "pi-coding-agent");
    try {
      const bin = (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> }).bin;
      const entry = typeof bin === "string" ? bin : bin?.pi;
      if (entry && existsSync(join(pkgDir, entry))) return nodeScript(join(pkgDir, entry));
    } catch { /* not installed through npm; fall through */ }
  }
  if (process.platform === "win32") {
    throw new Error("Could not find pi's cli.js. Install pi with `npm install -g @earendil-works/pi-coding-agent`, or set PI_BIN to the full path of its dist\\bundle\\cli.js.");
  }
  return { command: "pi", args: [], description: "pi (from PATH)" };
}

export interface Endpoint {
  baseUrl: string;
  apiKey: string | null;
  modelListed: boolean;
}

/** Reads the provider's baseUrl and key from pi's models.json, so the server address is configured in one place. */
export function readEndpoint(profile: Profile): Endpoint {
  const path = join(PATHS.piAgentDir, "models.json");
  let models: { providers?: Record<string, { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }> };
  try {
    models = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`Cannot read ${path}. Copy the example for this machine from deploy/pi-models/ (see README).`);
  }
  const provider = models.providers?.[profile.provider];
  if (!provider?.baseUrl) throw new Error(`${path} has no provider "${profile.provider}" with a baseUrl.`);
  let apiKey = provider.apiKey ?? null;
  const envRef = apiKey?.match(/^\$\{?([A-Z0-9_]+)\}?$/i);
  if (envRef) apiKey = process.env[envRef[1]] ?? null;
  if (apiKey?.startsWith("!")) apiKey = null; // command-sourced keys are resolved by pi only
  return { baseUrl: provider.baseUrl.replace(/\/+$/, ""), apiKey, modelListed: Boolean(provider.models?.some((m) => m.id === profile.model)) };
}

function headers(endpoint: Endpoint): Record<string, string> {
  return { "content-type": "application/json", ...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}) };
}

/** GET {baseUrl}/models works on Ollama, mlx_lm.server, LM Studio, llama.cpp and vLLM alike. */
export async function listServerModels(endpoint: Endpoint): Promise<string[]> {
  const response = await fetch(`${endpoint.baseUrl}/models`, { headers: headers(endpoint), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`GET ${endpoint.baseUrl}/models -> ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id);
}

/** Waits up to `minutes` for the server to answer; a Windows box may still be waking up. */
export async function waitForServer(endpoint: Endpoint, minutes = 5): Promise<string | null> {
  let last = "";
  for (const deadline = Date.now() + minutes * 60_000; Date.now() < deadline;) {
    try {
      await listServerModels(endpoint);
      return null;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return `model server at ${endpoint.baseUrl} not reachable after ${minutes} min (${last})`;
}

export interface ChatResult {
  content: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  promptTokens: number | null;
  completionTokens: number | null;
  seconds: number;
}

/** One non-streaming chat completion, used only by the doctor checks. */
export async function chat(endpoint: Endpoint, model: string, body: Record<string, unknown>, timeoutMs: number): Promise<ChatResult> {
  const started = Date.now();
  const response = await fetch(`${endpoint.baseUrl}/chat/completions`, {
    method: "POST", headers: headers(endpoint), signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({ model, stream: false, temperature: 0, ...body }),
  });
  if (!response.ok) throw new Error(`POST /chat/completions -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const message = json.choices?.[0]?.message;
  return {
    content: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((t) => ({ name: t.function.name, arguments: t.function.arguments })),
    promptTokens: json.usage?.prompt_tokens ?? null,
    completionTokens: json.usage?.completion_tokens ?? null,
    seconds: (Date.now() - started) / 1000,
  };
}

/** Rough token estimate (~3.5 characters per token for mixed English/Czech text plus JSON). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
