import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";

export class SecureFileError extends Error {
  readonly code = "SECURE_FILE_INVALID";

  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "SecureFileError";
  }
}

/**
 * Reads credential material without following a final symlink. The opened file,
 * rather than a path checked earlier, is validated to avoid a check/use race.
 */
export async function readOwnerOnlyFile(path: string, purpose: string): Promise<Buffer> {
  if (path.length === 0) throw new SecureFileError(`${purpose} file path is empty`);
  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new SecureFileError(`${purpose} must be a regular file`);
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new SecureFileError(`${purpose} must have exactly 0600 permissions`);
    }
    return await handle.readFile();
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    throw new SecureFileError(`${purpose} could not be loaded`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeOwnerOnlyFile(path: string, bytes: Buffer, purpose: string): Promise<void> {
  if (path.length === 0) throw new SecureFileError(`${purpose} file path is empty`);
  let handle;
  try {
    const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
    handle = await open(path, flags, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error instanceof SecureFileError) throw error;
    throw new SecureFileError(`${purpose} could not be written`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBearerTokenFile(path: string): Promise<string> {
  const token = (await readOwnerOnlyFile(path, "Bearer token")).toString("utf8").trim();
  if (token.length === 0 || /\s/u.test(token)) {
    throw new SecureFileError("Bearer token file must contain one non-empty token");
  }
  return token;
}
