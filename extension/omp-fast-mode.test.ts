import { execFileSync } from "node:child_process";
import test from "node:test";

// OMP publishes TypeScript sources requiring its native Bun runtime.
test("launch fast policy preserves omission and non-fast tiers, and reports unsupported priority", () => {
  execFileSync(
    "bun",
    [
      "-e",
      `
    import assert from "node:assert/strict";
    import { applyOmpFastMode } from "./extension/omp-fast-mode.ts";
    const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "native", identity: { class: "openai" } };
    const cases = [
      [undefined, codex, { openai: "ultrafast", google: "flex" }, { openai: "ultrafast", google: "flex" }, false],
      [true, codex, { openai: "flex", google: "flex" }, { openai: "priority", google: "flex" }, false],
      [true, { ...codex, serviceTiers: ["default"] }, { openai: "ultrafast" }, {}, true],
      [true, { ...codex, serviceTiers: ["default"] }, { openai: "flex" }, { openai: "flex" }, true],
      [true, { ...codex, serviceTiers: ["priority"] }, {}, { openai: "priority" }, false],
      [true, { provider: "unsupported", api: "openai-completions", id: "local", identity: { class: "unknown" } }, { openai: "priority" }, { openai: "priority" }, true],
      [true, { provider: "anthropic", api: "anthropic-messages", id: "native", identity: { class: "anthropic" } }, {}, { anthropic: "priority" }, false],
      [true, { provider: "openrouter", api: "anthropic-messages", id: "proxy", identity: { class: "anthropic" } }, { anthropic: "priority" }, {}, true],
      [true, { provider: "google", api: "google-generative-ai", id: "native", identity: { class: "gemini" } }, {}, { google: "priority" }, false],
      ...["priority", "ultrafast", "flex", "scale", "default"].map(tier => [false, codex, { openai: tier, google: "priority" }, { ...(tier === "priority" || tier === "ultrafast" ? {} : { openai: tier }), google: "priority" }, false]),
    ];
    for (const [mode, model, initial, expected, unsupported] of cases) {
      let tiers = { ...initial };
      const native = {
        getServiceTiers: () => tiers,
        setServiceTier(family, tier) {
          if (tier === undefined) delete tiers[family];
          else tiers[family] = tier;
        },
      };
      const warning = await applyOmpFastMode(native, model, mode);
      assert.deepEqual(tiers, expected, JSON.stringify({mode, model, initial}));
      assert.equal(typeof warning === "string", unsupported);
      if (unsupported) assert.match(warning, /fast.*unavailable/i);
    }
  `,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
});
