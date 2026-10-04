// Run from the source checkout. Mirror only tracked/non-ignored source files out of
// OneDrive; local .env files and user data are never copied. Changes are hot-synced.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const source = process.cwd();
const runtime = path.join(os.tmpdir(), "float-story-preview");
if (path.resolve(runtime) === path.resolve(source)) throw new Error("Preview must be outside the checkout");
fs.mkdirSync(runtime, { recursive: true });
function sync() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const file of files) {
    if (file.split(/[\\/]/).some(part => part.startsWith(".env"))) continue;
    const from = path.join(source, file), to = path.join(runtime, file);
    if (!fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    const content = fs.readFileSync(from);
    if (fs.existsSync(to) && content.equals(fs.readFileSync(to))) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
sync();
const depsIndex = process.argv.indexOf("--deps");
if (!fs.existsSync(path.join(runtime, "node_modules"))) {
  if (depsIndex >= 0) fs.symlinkSync(path.resolve(process.argv[depsIndex + 1]), path.join(runtime, "node_modules"), "junction");
  else {
    console.log(`Install dependencies once in ${runtime} with npm ci, then run this script again (or pass --deps <clean node_modules>).`);
    process.exit(1);
  }
}
let timer;
fs.watch(source, { recursive: true }, (_, name) => {
  if (!name || /(^|[\\/])(node_modules|\.git|\.next|\.gradle|build)([\\/]|$)/.test(name) || /(^|[\\/])\.env/.test(name)) return;
  clearTimeout(timer);
  timer = setTimeout(() => { try { sync(); } catch (error) { console.error("Preview sync failed", error.message); } }, 350);
});
const child = spawn(process.execPath, ["--max-old-space-size=4096", "scripts/local-next-server.mjs", "--dev", "--host", "127.0.0.1", "--port", "3107"], {
  cwd: runtime, stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_SELF_HOSTED_MODE: "true" },
});
console.log("Preview source:", source, "\nPreview runtime:", runtime, "\nUI demo: http://localhost:3107/dev/story-controls");
process.on("SIGINT", () => { child.kill(); process.exit(); });
child.on("exit", code => process.exit(code ?? 0));
