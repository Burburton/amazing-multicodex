const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const outputDirectory = path.join(projectRoot, "out");

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== "out") {
  throw new Error("Refusing to clean an unexpected output path.");
}

fs.rmSync(outputDirectory, { recursive: true, force: true });

