// Run from the source checkout. Mirror only tracked/non-ignored source files out of
// OneDrive; local .env files and user data are never copied. Changes are hot-synced.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
const source = process.cwd();
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
};
const port = arg("--port", "3111");
if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) throw new Error("Invalid preview port");
const runtime = path.resolve(arg("--runtime", path.join(os.tmpdir(), `float-preview-${port}`)));
const model = arg("--model", "qwen2.5:1.5b");
async function ollamaModels() {
  const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
  return (await response.json()).models ?? [];
}
let models;
try { models = await ollamaModels(); }
catch {
  const executable = arg("--ollama", process.env.FLOAT_OLLAMA_PATH || "ollama");
  const daemon = spawn(executable, ["serve"], {
    detached: true, windowsHide: true, stdio: "ignore",
    env: { ...process.env, OLLAMA_HOST: "127.0.0.1:11434", OLLAMA_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}` },
  });
  let failure;
  daemon.on("error", error => { failure = error; });
  daemon.unref();
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (failure) throw new Error(`Cannot start Ollama: ${failure.message}. Use --ollama <path>.`);
    try { models = await ollamaModels(); break; } catch { /* wait for startup */ }
  }
  if (!models) throw new Error("Ollama did not become ready; preview was not started.");
}
if (!models.some(item => item.name === model || item.model === model)) {
  throw new Error(`Local model ${model} is missing. Run ollama pull ${model} first (no automatic downloads).`);
}
console.log(`Ollama ready: ${model} at http://127.0.0.1:11434/v1`);
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
const child = spawn(process.execPath, ["--max-old-space-size=4096", "scripts/local-next-server.mjs", "--dev", "--host", "127.0.0.1", "--port", port], {
  cwd: runtime, stdio: "inherit", windowsHide: true,
  env: { ...process.env, NEXT_PUBLIC_SELF_HOSTED_MODE: "true", NEXT_PUBLIC_LOCAL_TEST_FIXTURES: "true",
    NEXT_PUBLIC_LOCAL_TEST_RUN: `${Date.now()}`, NEXT_PUBLIC_LOCAL_TEST_MODEL: model },
});
console.log("Preview source:", source, "\nPreview runtime:", runtime, `\nPreview: http://localhost:${port}/`);
process.on("SIGINT", () => { child.kill(); process.exit(); });
child.on("exit", code => process.exit(code ?? 0));
