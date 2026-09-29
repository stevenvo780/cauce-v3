import { copyFile, cp, mkdir } from "node:fs/promises";
import path from "node:path";

export async function materializeSupervisorOpsFixture(sourceRoot, temporaryRoot) {
  const targetRoot = path.join(temporaryRoot, "ops");
  await mkdir(targetRoot, { recursive: true });
  await Promise.all([
    cp(path.join(sourceRoot, "scripts"), path.join(targetRoot, "scripts"), { recursive: true }),
    cp(path.join(sourceRoot, "container-runtime"), path.join(targetRoot, "container-runtime"), { recursive: true }),
    cp(path.join(sourceRoot, "schemas"), path.join(targetRoot, "schemas"), { recursive: true }),
    copyFile(path.join(sourceRoot, "hermes-runtime.json"), path.join(targetRoot, "hermes-runtime.json")),
    copyFile(path.join(sourceRoot, "tests/fixtures/container-supervisor-aliases.json"), path.join(targetRoot, "container-aliases.json")),
  ]);
  return targetRoot;
}
