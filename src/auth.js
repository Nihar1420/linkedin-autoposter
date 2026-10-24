// Passwords, sign-in sessions and invite links.
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export const SESSION_DAYS = 30;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 8;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

/** A random token for a cookie or link. Only its hash is saved, so a copied database can't sign anyone in. */
export const newToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

export function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

/** Usernames are lowercase so "Nihar" and "nihar" are the same person. */
export function cleanUsername(value) {
  const name = String(value ?? "").trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/.test(name) ? name : null;
}

export function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Slows down password guessing: a few tries per address, then a pause. */
export function createRateLimit({ tries = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const seen = new Map();
  return (key) => {
    const now = Date.now();
    const entry = seen.get(key);
    if (!entry || entry.resetAt <= now) {
      seen.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= tries;
  };
}
