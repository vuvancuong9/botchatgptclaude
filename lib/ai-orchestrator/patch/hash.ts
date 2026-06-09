import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/**
 * Content hashing for patch base-drift protection.
 *
 * All hashes are SHA-256 hex. NOTHING here ever logs file content or secrets —
 * a hash is one-way and safe to store/audit; the raw content is never returned
 * or logged by these helpers.
 */

/** SHA-256 of a UTF-8 string. */
export function sha256Text(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** SHA-256 of raw bytes. */
export function sha256Buffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** SHA-256 of a file's raw bytes. */
export async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return sha256Buffer(buf);
}

/**
 * Normalize line endings (CRLF/CR → LF) so a base hash is stable across OSes /
 * git autocrlf checkout. Only line endings are touched — content is otherwise
 * byte-identical, so this does NOT corrupt the file (it's only for hashing).
 */
export function normalizeTextForHash(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The canonical "base drift" hash: SHA-256 of the UTF-8 content with line
 * endings normalized. The validate step (base file content) and the worker
 * (workspace file content) MUST both use this so a non-drifted file matches
 * regardless of CRLF/LF differences.
 */
export function driftHash(content: string): string {
  return sha256Text(normalizeTextForHash(content));
}

/** driftHash of a file read as UTF-8 text. */
export async function driftHashFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  return driftHash(text);
}
