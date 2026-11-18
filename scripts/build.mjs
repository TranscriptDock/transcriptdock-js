// Clean build of the ESM and CommonJS outputs with type declarations.
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
rmSync("dist", { recursive: true, force: true });
for (const project of ["tsconfig.json", "tsconfig.cjs.json"]) {
  execFileSync(process.execPath, [tsc, "-p", project], { stdio: "inherit" });
}
writeFileSync("dist/cjs/package.json", '{\n  "type": "commonjs"\n}\n');
