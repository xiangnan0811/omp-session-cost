const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI, "");
}

export function charWidth(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) return 2;
  return 1;
}

export function textWidth(value) {
  let out = 0;
  for (const ch of Array.from(stripAnsi(value).replace(/\t/g, "    "))) out += charWidth(ch);
  return out;
}

export function clipAnsi(value, maxWidth) {
  const source = String(value ?? "").replace(/\t/g, "    ");
  if (maxWidth <= 0) return "";
  if (textWidth(source) <= maxWidth) return source;
  if (maxWidth === 1) return "…";

  let out = "";
  let used = 0;
  const tokens = /(\x1b\[[0-?]*[ -/]*[@-~])|([\s\S])/g;
  let match;
  while ((match = tokens.exec(source))) {
    if (match[1]) {
      out += match[1];
      continue;
    }
    const width = charWidth(match[2]);
    if (used + width > maxWidth - 1) break;
    out += match[2];
    used += width;
  }
  return `${out}${source.includes("\x1b[") ? "\x1b[0m" : ""}…`;
}

export function fitAnsi(value, maxWidth) {
  const clipped = clipAnsi(value, maxWidth);
  return `${clipped}${" ".repeat(Math.max(0, maxWidth - textWidth(clipped)))}`;
}

export function formatInt(value) {
  return Math.round(finite(value)).toLocaleString("en-US");
}

export function formatTokens(value) {
  const n = finite(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}K`;
  return formatInt(n);
}

export function formatCost(value) {
  const n = finite(value);
  if (n === 0) return "$0.00";
  if (Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function percent(part, total) {
  return total > 0 ? finite(part) / finite(total) * 100 : 0;
}

export function formatPercent(value) {
  return `${finite(value).toFixed(1)}%`;
}

export function metricValue(row, metric) {
  if (!row) return 0;
  if (metric === "calls") return finite(row.calls ?? row.requests);
  if (metric === "tokens") return finite(row.measuredTokens ?? row.totalTokens);
  return finite(row.costTotal);
}

export function formatMetric(value, metric) {
  if (metric === "calls") return formatInt(value);
  if (metric === "tokens") return formatTokens(value);
  return formatCost(value);
}

export function metricTitle(metric) {
  if (metric === "calls") return "Calls";
  if (metric === "tokens") return "Tokens";
  return "Cost";
}

export function costIntensity(row, total) {
  const tokenShare = percent(row?.measuredTokens, total?.measuredTokens);
  const costShare = percent(row?.costTotal, total?.costTotal);
  return tokenShare > 0 ? costShare / tokenShare : 0;
}

export function formatRatio(value) {
  return `${finite(value).toFixed(2)}×`;
}

export function formatDuration(ms) {
  const value = Math.max(0, finite(ms));
  const seconds = Math.floor(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatTimestamp(timestamp) {
  const value = finite(timestamp);
  if (!value) return "n/a";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "n/a";
  }
}

export function sortRows(rows, metric = "cost", mode = "metric") {
  const list = [...(rows ?? [])];
  if (mode === "name") return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return list.sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || String(a.name).localeCompare(String(b.name)));
}

export function slugify(value) {
  const normalized = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  return normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}
