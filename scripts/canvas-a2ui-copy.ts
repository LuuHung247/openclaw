import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(repoRoot, "src", "canvas-host", "a2ui");
const outDir = path.join(repoRoot, "dist", "canvas-host", "a2ui");

async function main() {
  // canvas-host module has been removed; skip copy if source directory is absent
  try {
    await fs.stat(path.join(srcDir, "index.html"));
  } catch {
    // source not present — nothing to copy
    return;
  }
  await fs.stat(path.join(srcDir, "a2ui.bundle.js"));
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  await fs.cp(srcDir, outDir, { recursive: true });
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
