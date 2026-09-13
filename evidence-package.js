import { hash } from "./semantic.js";

const finite = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const tokenKeys = ["input", "cacheRead", "cacheWrite", "output"];
const costs = ["costInput", "costCacheRead", "costCacheWrite", "costOutput", "costTotal"];
export const REPLAY_COLUMNS = ["ref", "actor", "agent", "role", "task", "model", "status", ...tokenKeys,
  "orchestrationInput", "orchestrationCacheRead", "orchestrationOutput", "measuredTokens", ...costs, "priceStatus"];
const dimensions = ["actor", "agent", "role", "task", "model", "status", "priceStatus"];
const metrics = [...tokenKeys, "orchestrationInput", "orchestrationCacheRead", "orchestrationOutput", "measuredTokens", ...costs];

/** One compact row per selected usage record, including zero and incomplete records. */
export function buildReplay(data) {
  const dictionaries = Object.fromEntries(dimensions.map(k => [k, []]));
  const indices = Object.fromEntries(dimensions.map(k => [k, new Map()]));
  function intern(k, value) {
    value ??= null;
    if (!indices[k].has(value)) { indices[k].set(value, dictionaries[k].length); dictionaries[k].push(value); }
    return indices[k].get(value);
  }
  const rows = data.calls.map(c => {
    const values = { ref: c.ref, actor: c.actorType, agent: c.agent, role: c.role, task: c.taskKey,
      model: c.model, status: c.status, priceStatus: c.price?.status, ...c.usage?.fields,
      orchestrationInput: c.orchestration?.input ?? null, orchestrationOutput: c.orchestration?.output ?? null,
      orchestrationCacheRead: c.orchestration?.cacheRead ?? null, measuredTokens: c.measuredTokens ?? null };
    for (const [i, k] of [...tokenKeys, "total"].entries()) values[costs[i]] = c.price?.adopted?.[k] ?? null;
    return REPLAY_COLUMNS.map(k => dimensions.includes(k) ? intern(k, values[k]) : values[k] ?? null);
  });
  const expected = [{ dimension: "total", value: null, ...data.total }];
  for (const [dimension, entries, valueOf] of [["actor", data.actorTypes, r => r.actorType], ["model", data.models, r => r.name], ["task", data.ledger?.tasks, r => r.id]]) {
    for (const row of entries || []) expected.push({ dimension, value: valueOf(row), calls: row.calls,
      input: row.input, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, output: row.output,
      orchestrationInput: row.orchestrationInput, orchestrationOutput: row.orchestrationOutput, orchestrationCacheRead: row.orchestrationCacheRead,
      measuredTokens: row.measuredTokens, costTotal: row.costTotal });
  }
  return { recordType: "omp-cost-replay", version: 1, columns: REPLAY_COLUMNS, dictionaries, rows, expected,
    manifestDigest: hash(data.calls.map(c => c.ref).sort()),
    semantics: "Normalized plugin records, not provider billing. null stays unknown. Dimensions reuse the same rows; do not add them again." };
}

/** Recompute totals from exported rows, not from the plugin's claimed conservation checks. */
export function verifyReplay(replay) {
  const errors = [], checks = [], coverage = {};
  if (replay?.version !== 1 || JSON.stringify(replay.columns) !== JSON.stringify(REPLAY_COLUMNS) || !Array.isArray(replay.rows))
    return { ok: false, errors: ["unsupported-or-missing-replay"], checks, coverage };
  const refs = new Set(), groups = new Map(), expectedKeys = new Set();
  const key = (dim, value) => JSON.stringify([dim, value]);
  function add(dim, value, record) {
    const k = key(dim, value);
    if (!groups.has(k)) groups.set(k, { calls: 0, ...Object.fromEntries(metrics.map(m => [m, 0])) });
    const g = groups.get(k); g.calls++;
    for (const m of metrics) if (finite(record[m])) g[m] += record[m];
  }
  for (const [i, row] of replay.rows.entries()) {
    if (!Array.isArray(row) || row.length !== REPLAY_COLUMNS.length) { errors.push(`row-${i}: invalid shape`); continue; }
    const r = Object.fromEntries(REPLAY_COLUMNS.map((k, j) => [k, row[j]]));
    if (typeof r.ref !== "string" || !r.ref || refs.has(r.ref)) errors.push(`row-${i}: missing or duplicate ref`);
    else refs.add(r.ref);
    for (const d of dimensions) {
      const dictionary = replay.dictionaries?.[d];
      if (!Array.isArray(dictionary) || !Number.isInteger(r[d]) || r[d] < 0 || r[d] >= dictionary.length) errors.push(`row-${i}: invalid ${d} dictionary index`);
      r[d] = dictionary?.[r[d]];
    }
    for (const m of metrics) {
      if (r[m] !== null && (!finite(r[m]) || (!costs.includes(m) && !Number.isSafeInteger(r[m])))) errors.push(`row-${i}: invalid ${m}`);
      coverage[m] = (coverage[m] || 0) + Number(finite(r[m]));
    }
    const knownTokens = [...tokenKeys, "orchestrationInput", "orchestrationCacheRead", "orchestrationOutput"];
    if (knownTokens.every(k => finite(r[k])) && finite(r.measuredTokens) && knownTokens.reduce((sum, k) => sum + r[k], 0) !== r.measuredTokens) errors.push(`row-${i}: token-total-mismatch`);
    add("total", null, r); add("actor", r.actor, r); add("model", r.model, r); add("task", r.task, r);
  }
  if (!groups.has(key("total", null))) groups.set(key("total", null), { calls: 0, ...Object.fromEntries(metrics.map(m => [m, 0])) });
  if (hash([...refs].sort()) !== replay.manifestDigest) errors.push("record-manifest-mismatch");
  if (!Array.isArray(replay.expected) || !replay.expected.some(e => e.dimension === "total")) errors.push("missing-expected-totals");
  for (const expected of replay.expected || []) {
    if (!expected || typeof expected !== "object") { errors.push("invalid-expected-group"); continue; }
    for (const metric of ["calls", ...metrics.filter(m => !costs.includes(m)), "costTotal"])
      if (!finite(expected[metric])) errors.push(`missing-or-invalid-expected-metric:${expected.dimension}:${metric}`);
    const k = key(expected.dimension, expected.value);
    if (expectedKeys.has(k)) errors.push(`duplicate-expected-group:${k}`);
    expectedKeys.add(k);
    const actual = groups.get(k);
    if (!actual) { errors.push(`expected-group-not-in-rows:${k}`); continue; }
    for (const metric of ["calls", ...metrics]) {
      if (!finite(expected[metric])) continue;
      const tolerance = costs.includes(metric) ? Math.max(1e-8, Math.abs(expected[metric]) * 1e-10) : 0;
      const ok = Math.abs(actual[metric] - expected[metric]) <= tolerance;
      checks.push({ dimension: expected.dimension, value: expected.value, metric, expected: expected[metric], actual: actual[metric], ok });
    }
  }
  for (const k of groups.keys()) if (!expectedKeys.has(k)) errors.push(`rows-group-not-in-expected:${k}`);
  return { ok: errors.length === 0 && checks.every(c => c.ok), records: replay.rows.length, errors, checks, coverage,
    meaning: "Independent arithmetic replay of exported normalized records; does not prove upstream source or billing completeness." };
}

/** Stratified evidence, plus costly/slow/cold-cache tails. Soft limit never drops a required stratum. */
export function sampleCalls(calls, limit = 24) {
  const selected = new Map();
  const choose = c => { if (c) selected.set(c.ref, c); };
  for (const keyOf of [c => `${c.actorType}/${c.status}`, c => c.model, c => c.taskAttribution, c => c.purpose || "ordinary"]) {
    const seen = new Set();
    for (const c of calls) { const k = keyOf(c); if (!seen.has(k)) { seen.add(k); choose(c); } }
  }
  const cost = [...calls].sort((a, b) => (b.price?.adopted?.total || 0) - (a.price?.adopted?.total || 0));
  for (const c of cost.slice(0, 4)) choose(c);
  // Include input-heavy requests even when cheap pricing hides them from the cost tail.
  const cold = [...calls].filter(c => finite(c.usage?.fields?.input) && c.usage.fields.input > 0)
    .sort((a, b) => b.usage.fields.input - a.usage.fields.input).slice(0, 2);
  const streams = new Map();
  for (const c of calls) {
    const k = c.fileRef || c.instanceId || c.agent;
    if (!streams.has(k)) streams.set(k, []); streams.get(k).push(c);
  }
  for (const c of cold) {
    const stream = streams.get(c.fileRef || c.instanceId || c.agent), i = stream.indexOf(c);
    choose(stream[i - 1]); choose(c); choose(stream[i + 1]);
  }
  for (const c of [...calls].sort((a, b) => (b.requestDurationMs || 0) - (a.requestDurationMs || 0)).slice(0, 2)) choose(c);
  for (const c of calls.filter(c => c.status !== "success").slice(0, 8)) choose(c);
  choose(calls[0]); choose(calls.at(-1));
  for (const c of cost) { if (selected.size >= limit) break; choose(c); }
  return [...selected.values()];
}

export function closeParentRefs(events, seeds) {
  const byRef = new Map(events.map(e => [e.ref, e]));
  const byKey = new Map(events.map(e => [e.key, e]));
  const chosen = new Set(), missing = new Set(), queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i], e = byRef.get(id) || byKey.get(id);
    if (!e) { if (id) missing.add(id); continue; }
    if (chosen.has(e.ref)) continue;
    chosen.add(e.ref); if (e.parentRef) queue.push(e.parentRef);
  }
  return { events: events.filter(e => chosen.has(e.ref)), missing: [...missing] };
}

/** Inferred historical effective rates, never guessed official tiers or current prices. */
export function priceRateGroups(calls) {
  const groups = new Map();
  for (const c of calls) {
    const rate = Object.fromEntries(tokenKeys.map(k => {
      const amount = c.price?.adopted?.[k], base = c.usage?.fields?.[k];
      const orchestration = k === "cacheWrite" ? 0 : c.orchestration?.[k] ?? 0;
      return [k, finite(base) && base + orchestration > 0 && finite(amount) ? Number((amount * 1e6 / (base + orchestration)).toPrecision(10)) : null];
    }));
    const id = JSON.stringify([c.model, c.price?.source, rate]);
    if (!groups.has(id)) groups.set(id, { model: c.model, costSource: c.price?.source || "unknown", ratesPerMillion: rate,
      calls: 0, knownCost: 0, sampleRefs: [], pricingRule: "not-recorded", officialPriceVerified: false,
      derivation: "recorded category cost / (canonical category tokens + corresponding orchestration tokens)" });
    const g = groups.get(id); g.calls++; g.knownCost += c.price?.adopted?.total || 0;
    if (g.sampleRefs.length < 2) g.sampleRefs.push(c.ref);
  }
  return [...groups.values()];
}

export function finalizeEvidence(data) {
  const definitions = new Set(data.events.map(e => e.ref));
  const missingParents = [...new Set(data.events.map(e => e.parentRef).filter(r => r && !definitions.has(r)))];
  data.evidenceManifest = { recordType: "omp-cost-evidence-manifest", eventDefinitions: data.events.length, unresolvedParents: missingParents.map(ref => ({ ref, status: "source-not-in-frozen-snapshot" })),
    parentClosureComplete: missingParents.length === 0, content: "Original names, normalized usage, factual event metadata; no raw conversation or thinking." };
  data.replay = buildReplay(data);
  data.pricing.effectiveRateGroups = priceRateGroups(data.calls);
  data.pricing.crossCheck = data.measurement?.databaseCost?.coveredRecords ? "recorded-sources-compared" : "not-available: only one price source";
  return data;
}

/** Columnar ancestry retains every edge without repeating all nullable event fields. */
export function buildParentGraph(events) {
  const indices = new Map(events.map((e, i) => [e.ref, i]));
  const files = [...new Set(events.map(e => e.fileRef ?? null))];
  const fileIndex = new Map(files.map((file, i) => [file, i]));
  return { recordType: "omp-cost-parent-graph", version: 1, columns: ["ref", "parent", "file", "localLine"], files,
    rows: events.map(e => [e.ref, e.parentRef ? indices.has(e.parentRef) ? indices.get(e.parentRef) : e.parentRef : null, fileIndex.get(e.fileRef ?? null), e.localLine ?? null]),
    semantics: "parent: row index, null root, or unresolved external ref. file: files dictionary index. Factual links, not extra usage records." };
}

export function readParentGraph(graph) {
  if (graph?.version !== 1 || JSON.stringify(graph.columns) !== JSON.stringify(["ref", "parent", "file", "localLine"]) || !Array.isArray(graph.rows) || !Array.isArray(graph.files))
    return { events: [], errors: ["invalid-parent-graph-schema"] };
  const events = [], errors = [], seen = new Set();
  for (const [i, row] of graph.rows.entries()) {
    if (!Array.isArray(row) || row.length !== 4) { errors.push(`parent-row-${i}: shape`); continue; }
    const [ref, parent, file, localLine] = row;
    if (typeof ref !== "string" || !ref || seen.has(ref)) errors.push(`parent-row-${i}: duplicate-or-invalid-ref`);
    seen.add(ref);
    if (parent !== null && typeof parent !== "string" && (!Number.isInteger(parent) || parent < 0 || parent >= graph.rows.length)) errors.push(`parent-row-${i}: invalid-parent-index`);
    if (!Number.isInteger(file) || file < 0 || file >= graph.files.length) errors.push(`parent-row-${i}: invalid-file-index`);
    if (localLine !== null && (!Number.isSafeInteger(localLine) || localLine < 1)) errors.push(`parent-row-${i}: invalid-line`);
    events.push({ ref, parentRef: Number.isInteger(parent) ? graph.rows[parent]?.[0] : parent, fileRef: graph.files[file], localLine });
  }
  return { events, errors };
}
