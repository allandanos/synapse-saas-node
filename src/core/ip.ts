/**
 * IP / CIDR arithmetic for the trusted-proxy list (the reference leans on
 * Python's `ipaddress`; Node has no equivalent). IPv4 and IPv6, as `bigint`
 * so one code path covers both.
 */

const IPV4_BITS = 32;
const IPV6_BITS = 128;

interface ParsedAddress {
  readonly value: bigint;
  readonly bits: number;
}

function parseIpv4(text: string): ParsedAddress | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return { value, bits: IPV4_BITS };
}

function parseIpv6(text: string): ParsedAddress | null {
  if (!text.includes(":")) return null;
  const [head, tail, ...rest] = text.split("::");
  if (rest.length > 0) return null;
  const expand = (chunk: string | undefined): string[] => (chunk ? chunk.split(":").filter((g) => g.length > 0) : []);
  const left = expand(head);
  const right = expand(tail);
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return { value, bits: IPV6_BITS };
}

/** `203.0.113.7`, `::1`, `[::1]` → a comparable address, or null when it is not an IP. */
export function parseIpAddress(raw: string): ParsedAddress | null {
  const text = raw.trim().replace(/^\[|\]$/g, "");
  if (text.length === 0) return null;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) compares as the IPv4 address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  if (mapped?.[1]) return parseIpv4(mapped[1]);
  return text.includes(":") ? parseIpv6(text) : parseIpv4(text);
}

export interface Cidr {
  readonly network: bigint;
  readonly prefix: number;
  readonly bits: number;
}

/** `10.0.0.0/8` → a network, or null when it is not a valid CIDR (a bare address is /32 or /128). */
export function parseCidr(raw: string): Cidr | null {
  const [addressPart, prefixPart, ...rest] = raw.trim().split("/");
  if (rest.length > 0 || addressPart === undefined) return null;
  const address = parseIpAddress(addressPart);
  if (address === null) return null;
  let prefix = address.bits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix > address.bits) return null;
  }
  const hostBits = BigInt(address.bits - prefix);
  return { network: (address.value >> hostBits) << hostBits, prefix, bits: address.bits };
}

/** Is `host` inside `cidr`? Garbage on either side is simply "no". */
export function ipInCidr(host: string, cidr: string): boolean {
  const address = parseIpAddress(host);
  const network = parseCidr(cidr);
  if (address === null || network === null || address.bits !== network.bits) return false;
  const hostBits = BigInt(network.bits - network.prefix);
  return ((address.value >> hostBits) << hostBits) === network.network;
}
