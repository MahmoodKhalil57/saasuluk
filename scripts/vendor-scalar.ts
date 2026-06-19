/**
 * Vendor the PINNED Scalar standalone bundle into public/vendor/scalar/ so /scalar loads it from OUR origin — not a
 * third-party CDN. This is the "own the delivery" foundation of the Scalar-for-v4 fork (see @suluk/scalar/FORK.md
 * Phase 3): once we serve the exact bytes ourselves, a future source-patched build can be swapped in here. The
 * bundle is self-contained (no runtime chunk/CDN fetches), so a single file is enough. Build-time, idempotent.
 */
import { mkdirSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCALAR_VERSION } from "@suluk/scalar";

const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "public/vendor/scalar");
const file = join(dir, `standalone-${SCALAR_VERSION}.js`);
const url = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`;
const MIN = 1_000_000; // the real bundle is ~3.5 MB; anything smaller is an error page

if (existsSync(file) && statSync(file).size > MIN) {
  console.log(`✓ Scalar ${SCALAR_VERSION} already vendored (${(statSync(file).size / 1e6).toFixed(2)} MB)`);
} else {
  console.log(`Vendoring Scalar ${SCALAR_VERSION} from ${url} …`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✗ fetch failed: HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < MIN) {
    console.error(`✗ suspiciously small (${buf.length} bytes) — not vendoring`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, buf);
  console.log(`✓ Vendored Scalar → public/vendor/scalar/standalone-${SCALAR_VERSION}.js (${(buf.length / 1e6).toFixed(2)} MB)`);
}

// The PATCHED FORK bundle (latest Scalar + suluk v4 patches, built by tooling/ts/scalar-fork/build.sh) — for /reference.
// Prefer the fork's built artifact; on a fresh box that hasn't run the fork build, fall back to the upstream bundle so
// /reference still works (just without the native v4 panel) — run scalar-fork/build.sh to regenerate the real one.
const sulukFile = join(dir, "standalone-suluk.js");
const forkDist = join(root, "..", "suluk", "tooling", "ts", "scalar-fork", "dist", "standalone-suluk.js");
if (existsSync(sulukFile) && statSync(sulukFile).size > MIN) {
  console.log(`✓ Patched Scalar fork already vendored (${(statSync(sulukFile).size / 1e6).toFixed(2)} MB)`);
} else if (existsSync(forkDist) && statSync(forkDist).size > MIN) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(sulukFile, readFileSync(forkDist));
  console.log(`✓ Vendored patched Scalar fork from scalar-fork/dist`);
} else if (existsSync(file)) {
  console.warn(
    `! patched fork bundle missing — falling back to upstream for /reference (no v4 panel). Run tooling/ts/scalar-fork/build.sh.`,
  );
  writeFileSync(sulukFile, readFileSync(file));
}
