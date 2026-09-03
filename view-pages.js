import {
  costIntensity,
  formatCost,
  formatDuration,
  formatInt,
  formatPercent,
  formatRatio,
  formatTimestamp,
  formatTokens,
  metricTitle,
  percent,
} from "./format.js";

export function overviewRows(view, width) {
  const t = view.report.total;
  const rows = [
    view.heading("SUMMARY"),
    { text: `${view.muted("LLM calls")}             ${view.strong(formatInt(t.calls))}`, selectable: false },
    { text: `${view.muted("Failed calls")}          ${t.failed ? view.error(formatInt(t.failed)) : view.strong("0")}`, selectable: false },
    { text: `${view.muted("Measured tokens")}       ${view.strong(formatTokens(t.measuredTokens))}`, selectable: false },
    { text: `${view.muted("API-equivalent cost")}   ${view.warning(view.strong(formatCost(t.costTotal)))}`, selectable: false },
    { text: `${view.muted("Cache-read ratio")}      ${view.strong(formatPercent(percent(t.cacheRead, t.measuredTokens)))}`, selectable: false },
    view.separator(),
    view.heading("ACTOR TYPE"),
  ];
  if (width >= 94) {
    const nameWidth = Math.max(12, width - 62);
    rows.push({
      text: view.dim(`${"TYPE".padEnd(nameWidth)} ${"CALLS".padStart(8)} ${"CALL%".padStart(7)} ${"TOKENS".padStart(9)} ${"TOK%".padStart(7)} ${"COST".padStart(9)} ${"COST%".padStart(7)} BAR`),
      selectable: false,
    });
  } else {
    rows.push(view.columnHeader(width, "TYPE"));
  }
  for (const actor of view.sorted(view.report.actorTypes)) {
    rows.push(view.item(`actor:${actor.actorType}`, actor, { kind: "Actor type", renderer: "actor" }));
  }
  rows.push(view.separator(), view.heading("CONCENTRATION"));
  const provider = view.sorted(view.report.providers)[0];
  const model = view.sorted(view.report.models)[0];
  if (provider) rows.push(view.detail(`Top provider · ${provider.name} · ${formatPercent(view.share(provider, t))} of ${metricTitle(view.metric).toLowerCase()}`, 0));
  if (model) rows.push(view.detail(`Top model    · ${model.name} · ${formatPercent(view.share(model, t))} of ${metricTitle(view.metric).toLowerCase()}`, 0));
  const advisor = view.report.actorTypes.find(row => row.actorType === "advisor");
  if (advisor) rows.push(view.detail(`Advisor intensity · ${formatRatio(costIntensity(advisor, t))} relative cost per token`, 0));
  return rows;
}

export function providerRows(view, width) {
  const rows = [
    view.heading(`PROVIDERS · sorted by ${view.sortMode === "name" ? "name" : metricTitle(view.metric)} · percentage is share of the visible parent`),
    view.columnHeader(width),
  ];
  const expanded = view.tabState(view.expanded);
  for (const provider of view.sorted(view.report.providers)) {
    const providerId = `provider:${provider.name}`;
    rows.push(view.item(providerId, provider, {
      kind: "Provider",
      expandable: true,
      color: view.colorForProvider(provider.name),
    }));
    if (!expanded.has(providerId)) continue;
    rows.push(view.detail(`Models · percentages below are share of ${provider.name}`, 1));
    for (const model of view.sorted(provider.models)) {
      const modelId = `${providerId}/model:${model.name}`;
      const fullModel = view.report.models.find(row => row.name === model.name);
      rows.push(view.item(modelId, model, {
        kind: "Model",
        expandable: Boolean(fullModel?.agents?.length),
        parentId: providerId,
        depth: 1,
        parentTotal: provider,
        color: view.colorForModel(model.name),
      }));
      if (!expanded.has(modelId) || !fullModel) continue;
      rows.push(view.detail(`Agents · percentages below are share of ${model.name}`, 2));
      for (const agent of view.sorted(fullModel.agents)) {
        rows.push(view.item(`${modelId}/agent:${agent.name}`, agent, {
          kind: "Agent",
          parentId: modelId,
          depth: 2,
          parentTotal: fullModel,
          badge: view.badge(agent.agentType),
          color: view.colorForModel(model.name),
        }));
      }
    }
    rows.push(view.separator());
  }
  return rows;
}

export function modelRows(view, width) {
  const rows = [
    view.heading(`MODELS · sorted by ${view.sortMode === "name" ? "name" : metricTitle(view.metric)} · percentage is share of the visible parent`),
    view.columnHeader(width),
  ];
  const expanded = view.tabState(view.expanded);
  for (const model of view.sorted(view.report.models)) {
    const modelId = `model:${model.name}`;
    rows.push(view.item(modelId, model, {
      kind: "Model",
      expandable: Boolean(model.agents?.length),
      color: view.colorForModel(model.name),
    }));
    if (!expanded.has(modelId)) continue;
    rows.push(view.detail("Used by agents · percentages below are share of this model", 1));
    for (const agent of view.sorted(model.agents)) {
      rows.push(view.item(`${modelId}/agent:${agent.name}`, agent, {
        kind: "Agent",
        parentId: modelId,
        depth: 1,
        parentTotal: model,
        badge: view.badge(agent.agentType),
        color: view.colorForModel(model.name),
      }));
    }
    rows.push(view.separator());
  }
  return rows;
}

function agentGroup(view, rows, title, actorType) {
  const source = view.report.primaryAgents.filter(row => row.agentType === actorType);
  rows.push(view.heading(`${title} ${view.dim(`(${source.length})`)}`));
  const expanded = view.tabState(view.expanded);
  for (const agent of view.sorted(source)) {
    const agentId = `agent:${agent.agent}`;
    rows.push(view.item(agentId, agent, {
      kind: actorType === "main" ? "Main agent" : "Subagent",
      expandable: Boolean(agent.models?.length),
      badge: view.badge(actorType),
      color: view.colorForModel(agent.dominantModel),
    }));
    if (!expanded.has(agentId)) continue;
    rows.push(view.detail("Models · percentages below are share of this agent", 1));
    for (const model of view.sorted(agent.models)) {
      rows.push(view.item(`${agentId}/model:${model.name}`, model, {
        kind: "Model",
        parentId: agentId,
        depth: 1,
        parentTotal: agent,
        color: view.colorForModel(model.name),
      }));
    }
  }
  rows.push(view.separator());
}

export function agentRows(view, width) {
  const rows = [
    view.heading(`AGENTS · sorted by ${view.sortMode === "name" ? "name" : metricTitle(view.metric)} · Enter expands model attribution`),
    view.columnHeader(width),
  ];
  agentGroup(view, rows, "MAIN", "main");
  agentGroup(view, rows, "SUBAGENTS", "subagent");
  return rows;
}

function advisorGroup(view, rows, title, scope) {
  const source = view.report.advisors.filter(row => row.scope === scope);
  rows.push(view.heading(`${title} ${view.dim(`(${source.length})`)}`));
  if (!source.length) {
    rows.push(view.detail(scope === "main" ? "No main-session advisor activity recorded" : "No subagent advisor activity recorded", 0));
    rows.push(view.separator());
    return;
  }
  const expanded = view.tabState(view.expanded);
  for (const advisor of view.sorted(source)) {
    const advisorId = `advisor:${advisor.id}`;
    const label = `${advisor.ownerAgent} › advisor${advisor.advisorSlug ? `:${advisor.advisorSlug}` : ""}`;
    rows.push(view.item(advisorId, advisor, {
      kind: "Advisor",
      label,
      expandable: true,
      badge: view.badge("advisor"),
      color: view.colorForModel(advisor.dominantModel),
    }));
    if (!expanded.has(advisorId)) continue;
    const reviews = advisor.reviewUpdates;
    rows.push(
      view.detail(`Owner                ${advisor.ownerAgent}`, 1),
      view.detail(`Dominant model       ${advisor.dominantModel}`, 1),
      view.detail(`Review updates       ${formatInt(reviews)}`, 1),
      view.detail(`LLM calls / review   ${reviews ? (advisor.calls / reviews).toFixed(2) : "n/a"}`, 1),
      view.detail(`Tokens / review      ${reviews ? formatTokens(advisor.measuredTokens / reviews) : "n/a"}`, 1),
      view.detail(`Cost / review        ${reviews ? formatCost(advisor.costTotal / reviews) : "n/a"}`, 1),
      view.detail(`Advise tool calls    ${formatInt(advisor.adviseCalls)}`, 1),
      view.detail(`Other tool calls     ${formatInt(advisor.otherToolCalls)}`, 1),
      view.detail(`Delivered notes      ${formatInt(advisor.deliveredNotes)} in ${formatInt(advisor.deliveredCards)} card(s)`, 1),
      view.detail(`Primary follow-ups   ${formatInt(advisor.primaryFollowupCalls)} direct child call(s)`, 1),
      view.detail(`Requested severity   nit ${formatInt(advisor.requestedSeverity.nit)} · concern ${formatInt(advisor.requestedSeverity.concern)} · blocker ${formatInt(advisor.requestedSeverity.blocker)}`, 1),
      view.detail(`Delivered severity   nit ${formatInt(advisor.deliveredSeverity.nit)} · concern ${formatInt(advisor.deliveredSeverity.concern)} · blocker ${formatInt(advisor.deliveredSeverity.blocker)}`, 1),
    );
    if (advisor.firstTimestamp && advisor.lastTimestamp) {
      rows.push(view.detail(`Activity window      ${formatTimestamp(advisor.firstTimestamp)} → ${formatTimestamp(advisor.lastTimestamp)} (${formatDuration(advisor.lastTimestamp - advisor.firstTimestamp)})`, 1));
    }
    if (advisor.models?.length) {
      rows.push(view.detail("Models · percentages below are share of this advisor", 1));
      for (const model of view.sorted(advisor.models)) {
        rows.push(view.item(`${advisorId}/model:${model.name}`, model, {
          kind: "Model",
          parentId: advisorId,
          depth: 1,
          parentTotal: advisor,
          color: view.colorForModel(model.name),
        }));
      }
    }
    rows.push(view.separator());
  }
}

export function advisorRows(view, width) {
  const rows = [
    view.heading("ADVISORS · review behavior, owner attribution, and model distribution"),
    view.columnHeader(width),
  ];
  advisorGroup(view, rows, "MAIN-SESSION ADVISORS", "main");
  advisorGroup(view, rows, "SUBAGENT ADVISORS", "subagent");
  return rows;
}

export function detailsRows(view) {
  const m = view.report.metadata;
  const p = view.report.pricing ?? {};
  const rows = [
    view.heading("SESSION"),
    view.detail(`ID                    ${view.report.sessionId}`, 0, "text"),
    view.detail(`Root transcript       ${view.report.rootSessionFile}`, 0, "mdCode"),
    view.detail(`Generated             ${formatTimestamp(view.report.generatedAt)}`, 0),
    view.separator(),
    view.heading("SCAN"),
    view.detail(`Transcript files discovered      ${formatInt(m.filesDiscovered)}`, 0),
    view.detail(`Valid transcript files scanned   ${formatInt(m.filesScanned)}`, 0),
    view.detail(`Invalid transcript-like skipped  ${formatInt(m.skippedInvalidFiles)}`, 0),
    view.detail(`Fork-aware incremental view      ${m.forkAware ? "yes" : "no"}`, 0),
    view.detail(`Inherited calls excluded         ${formatInt(m.excludedInheritedCalls)}`, 0),
    view.detail(`Duplicate calls removed          ${formatInt(m.duplicateCallsRemoved)}`, 0),
    view.separator(),
    view.heading("PRICING"),
    view.detail(`stats.db              ${p.dbPath ?? "not found; transcript prices used"}`, 0, p.dbPath ? "mdCode" : "muted"),
    view.detail(`stats.db matches      ${formatInt(p.dbMatched)}`, 0),
    view.detail(`Stats refresh         ${p.sync?.attempted ? (p.sync.ok ? "ok" : "failed") : "not requested"}`, 0, p.sync?.attempted && !p.sync.ok ? "warning" : "muted"),
    view.detail(`Price sources         ${Object.entries(p.sourceCounts ?? {}).map(([key, value]) => `${key}:${value}`).join(" · ") || "none"}`, 0),
    view.separator(),
    view.detail("API-equivalent cost is an analytical estimate. Subscription and OAuth billing can differ.", 0),
  ];
  if (p.dbError) rows.push(view.detail(`stats.db warning      ${p.dbError}`, 0, "warning"));
  return rows;
}
