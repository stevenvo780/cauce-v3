import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { MAX_ATTACHMENT_BYTES } from "@cauce/protocol";
import { materializeAttachments, sweepStaleTurnDirectories } from "../src/sdk/attachments.js";
import { releaseAttachments } from "../src/sdk/engine/turn-cleanup.js";
import type { AdapterLog, CommandRunRequest, CommandRunResult, Delivery } from "../src/sdk/types.js";
import { ControlledRunner, delivery, setup } from "./engine-fixtures.js";

function attachment(name: string, payload: Buffer): Record<string, unknown> {
  return {
    kind: "document",
    name,
    mime_type: "application/octet-stream",
    file_size: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    content_base64: payload.toString("base64"),
  };
}

/**
 * The protocol admits 10 MB per attachment, so the adapter has to materialize exactly that: a
 * validator that gives up before the cap turns an accepted delivery into a lost turn.
 */
test("un adjunto del tamaño máximo del protocolo se materializa entero", async () => {
  const payload = Buffer.alloc(MAX_ATTACHMENT_BYTES, 7);
  const result = await materializeAttachments({ attachments_v1: [attachment("grande.bin", payload)] });
  assert.ok(result);
  const materialized = result.attachments[0];
  assert.ok(materialized);
  assert.ok((await readFile(materialized.path)).equals(payload));
  await result.cleanup();
  await assert.rejects(access(materialized.path), { code: "ENOENT" });
});

/**
 * Every validator on the name counts characters and the filesystem counts bytes. A name the
 * schema accepts must still reach the disk: the file keeps its declared name for the agent and
 * a shortened one on disk, never a failed turn.
 */
test("un nombre válido para el esquema pero más largo que NAME_MAX llega igual", async () => {
  const payload = Buffer.from("contenido", "utf8");
  for (const name of [`${"a".repeat(251)}.txt`, `${"🚀".repeat(64)}.txt`, "b".repeat(255)]) {
    const result = await materializeAttachments({ attachments_v1: [attachment(name, payload)] });
    assert.ok(result, name);
    const materialized = result.attachments[0];
    assert.ok(materialized);
    assert.equal(materialized.name, name);
    const onDisk = basename(materialized.path);
    assert.ok(Buffer.byteLength(onDisk, "utf8") <= 255, onDisk);
    assert.ok(onDisk.startsWith("1-"));
    if (name.endsWith(".txt")) assert.ok(onDisk.endsWith(".txt"), onDisk);
    assert.ok((await readFile(materialized.path)).equals(payload));
    assert.match(result.prompt, /"local_path":"[^"]+"/u);
    await result.cleanup();
  }
});

test("el base64 corrupto o no canónico sigue siendo un adjunto inválido", async () => {
  const base = attachment("hola.txt", Buffer.from("hola", "utf8"));
  for (const content_base64 of ["aG9sYQ", "aG9sYQ=!", "aG9sYQ===", "aG9sYR=="]) {
    await assert.rejects(
      materializeAttachments({ attachments_v1: [{ ...base, content_base64 }] }),
      { code: "INVALID_ATTACHMENT" },
      content_base64,
    );
  }
});

function conAdjunto(id: string): Delivery {
  const payload = Buffer.from("%PDF-1.7\nun informe", "utf8");
  return {
    ...delivery(id),
    body: {
      type: "telegram.message",
      timeout_ms: 2_000,
      attachments_v1: [{ ...attachment("informe.pdf", payload), mime_type: "application/pdf" }],
    },
  };
}

function rutaMaterializada(request: CommandRunRequest | undefined): string {
  const path = /"local_path":"([^"]+)"/u.exec(request?.stdin ?? "")?.[1];
  assert.ok(path, "el prompt debe declarar la ruta local del adjunto");
  return path;
}

test("con CAUCE_AGENT_WORKSPACE el adjunto vive en el espacio del agente y el arnés corre allí", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cauce-espacio-"));
  process.env.CAUCE_AGENT_WORKSPACE = workspace;
  try {
    const context = await setup("adjunto-espacio-del-agente");
    await context.engine.handleDelivery(conAdjunto("adjunto-espacio"));

    const request = context.runner.requests[0];
    assert.equal(request?.cwd, workspace);
    assert.ok(rutaMaterializada(request).startsWith(`${workspace}/`));
    assert.equal(context.events.at(-1)?.phase, "done");
  } finally {
    delete process.env.CAUCE_AGENT_WORKSPACE;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("sin CAUCE_AGENT_WORKSPACE se cae a tmpdir y el arnés no recibe cwd", async () => {
  delete process.env.CAUCE_AGENT_WORKSPACE;
  const context = await setup("adjunto-sin-espacio");
  await context.engine.handleDelivery(conAdjunto("adjunto-tmpdir"));

  const request = context.runner.requests[0];
  assert.equal(request?.cwd, undefined);
  assert.ok(rutaMaterializada(request).startsWith(`${tmpdir()}/`));
  assert.equal(context.events.at(-1)?.phase, "done");
});

test("una limpieza que falla no cuesta el turno ni la respuesta", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cauce-espacio-sellado-"));
  process.env.CAUCE_AGENT_WORKSPACE = workspace;
  class RunnerQueBloqueaElBorrado extends ControlledRunner {
    override async run(request: CommandRunRequest): Promise<CommandRunResult> {
      await chmod(workspace, 0o500);
      return super.run(request);
    }
  }
  try {
    const context = await setup("adjunto-limpieza-imposible", new RunnerQueBloqueaElBorrado());
    await context.engine.handleDelivery(conAdjunto("adjunto-limpieza"));

    assert.equal(context.events.at(-1)?.phase, "done");
    assert.equal(context.events.at(-1)?.error, undefined);
  } finally {
    delete process.env.CAUCE_AGENT_WORKSPACE;
    await chmod(workspace, 0o700);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("releaseAttachments se traga el fallo del borrado y lo deja registrado", async () => {
  const logs: AdapterLog[] = [];
  let intentos = 0;

  await releaseAttachments(
    {
      prompt: "",
      attachments: [],
      directory: "/inexistente/turno",
      workspace: "/inexistente",
      cleanup: async () => {
        intentos += 1;
        throw new Error("el borrado falló");
      },
    },
    (entry) => logs.push(entry),
    delivery("limpieza-fallida"),
  );

  assert.equal(intentos, 1);
  assert.equal(String(logs.at(-1)?.event), "attachment_cleanup_failed");
  assert.equal(logs.at(-1)?.delivery_id, "limpieza-fallida");
  assert.equal(logs.at(-1)?.alias, "argos");
});

test("el arranque barre los directorios de turno viejos del espacio y respeta lo demás", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cauce-barrido-"));
  const viejo = join(workspace, "cauce-attachments-viejo");
  const reciente = join(workspace, "cauce-attachments-reciente");
  const ajeno = join(workspace, "notas-del-agente");
  const hace = (ms: number): Date => new Date(Date.now() - ms);
  try {
    for (const path of [viejo, reciente, ajeno]) await mkdir(path);
    await writeFile(join(viejo, "credencial"), "no debería seguir acá", { mode: 0o600 });
    await utimes(viejo, hace(7_200_000), hace(7_200_000));
    await utimes(ajeno, hace(7_200_000), hace(7_200_000));

    assert.equal(await sweepStaleTurnDirectories(workspace), 1);

    await assert.rejects(access(viejo), { code: "ENOENT" });
    await access(reciente);
    await access(ajeno);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("el barrido respeta el turno vivo de otro proceso y se lleva el del proceso muerto", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cauce-barrido-vivo-"));
  const vivo = join(workspace, "cauce-attachments-vivo");
  const muerto = join(workspace, "cauce-attachments-muerto");
  const ilegible = join(workspace, "cauce-attachments-ilegible");
  const pidMuerto = spawnSync(process.execPath, ["-e", "0"]).pid;
  const hace = (ms: number): Date => new Date(Date.now() - ms);
  try {
    assert.ok(pidMuerto > 0 && pidMuerto !== process.pid);
    for (const [path, marker] of [
      [vivo, `${String(process.pid)}\n`],
      [muerto, `${String(pidMuerto)}\n`],
      [ilegible, "no-soy-un-pid\n"],
    ] as const) {
      await mkdir(path);
      await writeFile(join(path, ".cauce-turn"), marker, { mode: 0o600 });
      await utimes(path, hace(7_200_000), hace(7_200_000));
    }

    assert.equal(await sweepStaleTurnDirectories(workspace), 2);

    await access(vivo);
    await assert.rejects(access(muerto), { code: "ENOENT" });
    await assert.rejects(access(ilegible), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("el directorio del turno lleva el marcador del proceso que lo creó", async () => {
  const result = await materializeAttachments({
    attachments_v1: [attachment("nota.txt", Buffer.from("hola", "utf8"))],
  });
  assert.ok(result);
  assert.equal((await readFile(join(result.directory, ".cauce-turn"), "utf8")).trim(), String(process.pid));
  await result.cleanup();
  await assert.rejects(access(join(result.directory, ".cauce-turn")), { code: "ENOENT" });
});
