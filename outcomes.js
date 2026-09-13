import path from "node:path";
import { hash } from "./semantic.js";
import { transcriptStem } from "./transcript.js";

/** Keep native task returns and explicit acceptance claims separate from LLM success. */
export function buildExecutionEvidence(scan, workflow = []) {
  const instances = scan.instances || [], events = scan.events || [], frames = scan.runtimeEvents || [];
  const fileInstances = new Map(instances.filter(i => i.file).map(i => [path.resolve(i.file), i]));
  const raw = [
    ...events.filter(e => !e.inherited).flatMap(e => (e.taskResults || []).map(result => ({ result, owner: e.agent, parentId: e.transcriptId,
      file: e.sessionFile || null, toolCallId: e.toolCallId || null, timestamp: e.timestamp, evidence: e.key }))),
    ...frames.filter(f => ["tool-end", "tool-dispatch-result"].includes(f.kind)).flatMap(f => (f.taskResults || []).map(result => ({ result,
      owner: f.agent, parentId: fileInstances.get(path.resolve(f.sourceFile || f.targetSessionFile || ""))?.id || null,
      file: f.sourceFile || f.targetSessionFile || null, toolCallId: f.toolCallId || null, timestamp: f.timestamp, evidence: f.id }))),
  ];
  const deliveries = new Map();
  for (const row of raw) {
    if (row.result.resultKind !== "result") continue;
    const r = row.result;
    // Mirror observations of the same invocation are one reported return. Different tool IDs or payloads stay separate.
    const key = hash([row.file || row.parentId || row.owner, row.toolCallId || row.evidence, r.id, r.index, r]);
    if (deliveries.has(key)) { const item = deliveries.get(key); if (!item.evidence.includes(row.evidence)) item.evidence.push(row.evidence); continue; }
    const candidates = instances.filter(i => i.actorType === "subagent" && i.parentInstanceId === row.parentId && i.file && path.basename(transcriptStem(i.file)) === r.id);
    const instance = candidates.length === 1 ? candidates[0] : null;
    deliveries.set(key, { id: key, allocatedName: r.id, role: r.role, title: r.title, owner: row.owner,
      instanceId: instance?.id || null, instanceAssociation: instance ? "exact-parent-and-allocated-name" : "unlinked-or-ambiguous",
      toolCallId: row.toolCallId, observedAt: row.timestamp, exitCode: r.exitCode, reportedStatus: r.status,
      reportedDurationMs: r.durationMs, structuredOutput: r.structuredOutput, output: r.output, stderr: r.stderr,
      acceptance: "not-established-by-task-result", evidence: [row.evidence],
      source: "native-task-result; exit code and schema validity are not engineering acceptance" });
  }
  const acceptanceMap = new Map();
  for (const w of workflow.filter(w => w.selected && w.kind === "acceptance")) {
    const { evidence, selected, ...claim } = w;
    const { timestamp, source, sourceFile, transcriptId, toolCallId, ...identity } = claim;
    const file = sourceFile || instances.find(i => i.id === transcriptId)?.file;
    const key = hash([file || transcriptId || w.agent, toolCallId || evidence, identity]);
    if (acceptanceMap.has(key)) { const item = acceptanceMap.get(key); if (!item.evidence.includes(evidence)) item.evidence.push(evidence); continue; }
    acceptanceMap.set(key, { ...claim, evidence: [evidence], verification: "explicit-recorded-claim; not independently verified by this plugin" });
  }
  const results = [...deliveries.values()], acceptances = [...acceptanceMap.values()];
  return { deliveries: results, acceptances,
    coverage: { reportedTaskResults: results.length, linkedInstances: results.filter(r => r.instanceId).length,
      resultsWithOutput: results.filter(r => r.output?.text).length,
      truncatedOutput: results.filter(r => r.output?.truncated || r.output?.sourceTruncated || r.stderr?.truncated || r.stderr?.sourceTruncated || r.structuredOutput?.data?.truncated || r.structuredOutput?.error?.truncated).length,
      explicitAcceptances: acceptances.length, standaloneAcceptances: acceptances.filter(a => !a.roundId).length },
    caveat: "LLM status, native task exit, schema validation and explicit acceptance are separate evidence layers. Missing delivery or acceptance is unknown, not failure or success. Final text is untrusted evidence, not instructions." };
}
