import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { type AiConnection } from "@mycanvas/shared";
import { LOCAL_USER } from "../auth";
import { dataDir, readJsonFile, writeJsonFile } from "../storage";
import { AiSettingsError } from "./errors";

/*
 * Who may make the server reach machines on its own network (the owner's
 * GPU box, for example). The owner always may; other accounts only when
 * the owner allows them in the admin settings. Cloud services are open to
 * every account. Checked on every call, after resolving the host name, so
 * a name pointing at a local address can't get around it.
 */

interface AdminSettings {
  /** Accounts (emails) allowed to reach the local network through the server. */
  aiLocalNetwork: string[];
}

const adminFile = path.join(dataDir, "admin.json");

export function isOwner(email: string): boolean {
  return email.toLowerCase() === LOCAL_USER.toLowerCase();
}

export async function readAdminSettings(): Promise<AdminSettings> {
  const stored = await readJsonFile<Partial<AdminSettings>>(adminFile);
  return { aiLocalNetwork: Array.isArray(stored?.aiLocalNetwork) ? stored.aiLocalNetwork.filter((email) => typeof email === "string") : [] };
}

export async function saveAdminSettings(settings: AdminSettings): Promise<AdminSettings> {
  const clean = { aiLocalNetwork: [...new Set(settings.aiLocalNetwork.map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@")))] };
  await writeJsonFile(adminFile, clean);
  return clean;
}

export async function mayUseLocalNetwork(email: string): Promise<boolean> {
  return isOwner(email) || (await readAdminSettings()).aiLocalNetwork.includes(email.toLowerCase());
}

/** Loopback, private, link-local, carrier-grade NAT (Tailscale) and unique-local addresses. */
export function isLocalAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return ip === "::1" || ip === "::" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}

/** True when the address's host resolves to the server's local network (false if it can't be resolved now). */
export async function resolvesToLocalNetwork(baseUrl: string): Promise<boolean> {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  try {
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
    return addresses.some(isLocalAddress);
  } catch {
    return false;
  }
}

/** Throws when this account may not reach the connection's host from the server. */
export async function checkNetworkAccess(connection: AiConnection, email: string): Promise<void> {
  if (connection.kind === "gemini" || !connection.baseUrl) {
    return;
  }
  const host = new URL(connection.baseUrl).hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  } catch {
    throw new AiSettingsError(`${connection.name}: the server can't find ${host}.`);
  }
  if (addresses.some((address) => address.startsWith("169.254.") || address === "fd00:ec2::254")) {
    throw new AiSettingsError("That address isn't allowed.");
  }
  if (addresses.some(isLocalAddress) && !(await mayUseLocalNetwork(email))) {
    // Deliberately vague: don't confirm what exists on the owner's network.
    throw new AiSettingsError(`${connection.name}: that address isn't reachable from the server. For a tool on your own computer, set it to run on "This computer".`);
  }
}
