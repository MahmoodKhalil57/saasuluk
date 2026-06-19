// Flat config. Correctness-only (Prettier owns formatting, so there are no stylistic rules here to fight it).
// Pragmatic on an existing dense codebase: real-bug rules stay errors; noisy-but-not-wrong patterns are warnings,
// and ESLint only FAILS on errors — so CI is green on warnings while still surfacing them.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/",
      ".astro/",
      "node_modules/",
      ".wrangler/",
      "worker/dist/",
      "output/",
      "downloads/",
      "temp/",
      "public/**", // generated schemes.css, vendored scalar bundle, sw.js, etc.
      "openapi.json",
      "src/build-id.ts", // generated (git SHA)
      "src/themes/schemes/**", // generated theme projections
      "**/*.min.js",
      "bun.lock",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-unused-expressions": "warn", // `void el.offsetWidth` reflow trick, etc.
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-cond-assign": ["error", "except-parens"],
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-var": "warn", // legacy `var` in terse inline glue — flagged, not blocking (off entirely in .astro below)
      "no-useless-assignment": "warn",
      "no-control-regex": "warn", // intentional in input sanitizers (stripping control chars)
      "no-useless-escape": "warn",
      "no-irregular-whitespace": "warn", // RTL/Arabic + special chars in copy
    },
  },
  {
    // Astro pages carry runtime-loaded globals (window.toast/$stores, Leaflet's L, Stripe, etc.) and terse DOM glue
    // written as old-school browser-safe inline scripts (var, etc.) — keep those idioms, lint only for real bugs.
    files: ["**/*.astro"],
    rules: {
      "no-undef": "off", // browser + app globals are injected at runtime, not importable
      "no-var": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Build/CI scripts are Node/Bun CLIs.
    files: ["scripts/**", "*.config.{js,mjs,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
