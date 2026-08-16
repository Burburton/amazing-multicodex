const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const violations = [];

for (const file of sourceFiles(sourceRoot)) {
  if (file.endsWith(".test.ts")) continue;
  const relative = unix(path.relative(projectRoot, file));
  const content = fs.readFileSync(file, "utf8");
  const imports = [...content.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)]
    .map(match => match[1]);

  for (const specifier of imports) {
    checkDomainIsolation(relative, specifier);
    checkAdapterDirection(relative, specifier);
    checkCrossModuleBoundary(file, relative, specifier);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map(item => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Architecture boundaries passed.\n");
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : entry.name.endsWith(".ts") ? [target] : [];
  });
}

function checkDomainIsolation(relative, specifier) {
  if (!/^src\/modules\/[^/]+\/domain\//.test(relative)) return;
  if (specifier === "vscode" || specifier.startsWith("node:") || specifier.includes("/adapters/")) {
    violations.push(`${relative}: domain code cannot import '${specifier}'`);
  }
}

function checkAdapterDirection(relative, specifier) {
  if (!relative.startsWith("src/modules/") || !specifier.startsWith(".")) return;
  const normalized = unix(path.normalize(path.join(path.dirname(relative), specifier)));
  if (normalized.startsWith("src/adapters/")) {
    violations.push(`${relative}: modules cannot import adapter '${specifier}'`);
  }
}

function checkCrossModuleBoundary(file, relative, specifier) {
  const owner = relative.match(/^src\/modules\/([^/]+)\//)?.[1];
  if (!owner || !specifier.startsWith(".")) return;
  const resolved = unix(path.relative(projectRoot, path.resolve(path.dirname(file), specifier)));
  const target = resolved.match(/^src\/modules\/([^/]+)\/(.+)$/);
  if (!target || target[1] === owner) return;
  if (target[2] !== "public" && target[2] !== "public.ts") {
    violations.push(`${relative}: cross-module import '${specifier}' must target ${target[1]}/public`);
  }
}

function unix(value) {
  return value.split(path.sep).join("/");
}

