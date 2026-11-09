import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "./storage";

/*
 * Encryption for stored secrets (AI keys). AES-256-GCM with a master key
 * from MYCANVAS_SECRET_KEY, which lives in the deployment's environment,
 * not in the data volume, so data backups don't carry readable keys.
 * Development without that variable uses a key file next to the data.
 */

let masterKey: Buffer | null = null;

async function key(): Promise<Buffer> {
  if (masterKey) {
    return masterKey;
  }
  const configured = process.env.MYCANVAS_SECRET_KEY?.trim();
  if (configured) {
    // Any string works; hashing gives exactly 32 bytes.
    masterKey = createHash("sha256").update(configured).digest();
    return masterKey;
  }
  if (process.env.NODE_ENV === "production") {
    throw new SecretsUnavailableError();
  }
  const file = path.join(dataDir, ".dev-secret-key");
  if (!existsSync(file)) {
    await writeFile(file, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  masterKey = createHash("sha256").update((await readFile(file, "utf8")).trim()).digest();
  return masterKey;
}

export class SecretsUnavailableError extends Error {
  constructor() {
    super("This server isn't set up to store keys (MYCANVAS_SECRET_KEY is missing).");
  }
}

/** `context` binds the ciphertext to where it belongs (e.g. workspace + connection). */
export async function encryptSecret(plain: string, context: string): Promise<string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(), iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export async function decryptSecret(sealed: string, context: string): Promise<string> {
  const [version, iv, tag, data] = sealed.split(":");
  if (version !== "v1" || !iv || !tag || !data) {
    throw new Error("Unreadable secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", await key(), Buffer.from(iv, "base64"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
