const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const extension = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const contributed = manifest.contributes.commands.map(command => command.command);
const registered = [...extension.matchAll(/registerCommand\("([^"]+)"/g)].map(match => match[1]);
const activated = manifest.activationEvents
  .filter(event => event.startsWith("onCommand:"))
  .map(event => event.slice("onCommand:".length));
const menuCommands = Object.values(manifest.contributes.menus)
  .flat()
  .map(item => item.command);

const failures = [];
checkUnique("contributed command", contributed);
checkUnique("registered command", registered);
checkUnique("command activation event", activated);
checkSubset("registered", registered, contributed);
checkSubset("activated", activated, contributed);
checkSubset("menu", menuCommands, contributed);
checkSubset("contributed", contributed, registered);
checkSubset("contributed activation", contributed, activated);

if (failures.length > 0) {
  process.stderr.write(`Manifest consistency violations:\n${failures.map(item => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Manifest command consistency passed.\n");
}

function checkUnique(label, values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) failures.push(`duplicate ${label} '${value}'`);
    seen.add(value);
  }
}

function checkSubset(label, values, allowed) {
  const allowedSet = new Set(allowed);
  for (const value of new Set(values)) {
    if (!allowedSet.has(value)) failures.push(`${label} command '${value}' is missing its matching declaration`);
  }
}
