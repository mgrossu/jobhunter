import { readFileSync, writeFileSync } from "node:fs";

const [target] = process.argv.slice(2);
const config = JSON.parse(readFileSync("/app/config/jobhunter.json", "utf8"));
const name = process.env.JH_PROFILE ?? config.defaultProfile;
const profile = config.profiles[name];
if (!profile) throw new Error(`profile "${name}" not in config/jobhunter.json`);

const models = {
  providers: {
    [profile.provider]: {
      baseUrl: process.env.JH_LLM_BASE_URL.replace(/\/+$/, ""),
      api: "openai-completions",
      apiKey: process.env.JH_LLM_API_KEY ? "$JH_LLM_API_KEY" : "local",
      models: [{
        id: profile.model,
        reasoning: false,
        contextWindow: profile.contextTokens,
        maxTokens: 4096,
        compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false },
      }],
    },
  },
};
writeFileSync(target, `${JSON.stringify(models, null, 2)}\n`);
console.log(`[entrypoint] pi models.json: ${profile.provider}/${profile.model} at ${process.env.JH_LLM_BASE_URL}`);
