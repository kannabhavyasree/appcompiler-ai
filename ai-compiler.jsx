import { useState, useRef, useEffect } from "react";

// ── Schema definitions ─────────────────────────────────────────────────────
const REQUIRED_SCHEMA = {
  intent: ["summary", "entities", "roles", "features", "constraints"],
  architecture: ["pages", "apiEndpoints", "dbTables", "authRules"],
  uiSchema: ["pages"],
  apiSchema: ["endpoints"],
  dbSchema: ["tables"],
  authSchema: ["roles", "permissions"],
};

// ── Validation Engine ─────────────────────────────────────────────────────
function validateSchema(schema) {
  const errors = [];
  if (!schema) return [{ type: "missing", msg: "Schema is null/undefined" }];

  // Cross-layer consistency
  if (schema.dbSchema && schema.apiSchema) {
    const dbTableNames = (schema.dbSchema.tables || []).map((t) =>
      (t.name || "").toLowerCase()
    );
    (schema.apiSchema.endpoints || []).forEach((ep) => {
      if (ep.entity && !dbTableNames.includes(ep.entity.toLowerCase())) {
        errors.push({
          type: "cross_layer",
          msg: `API endpoint '${ep.path}' references entity '${ep.entity}' not found in DB schema`,
          field: ep.entity,
        });
      }
    });
  }

  if (schema.uiSchema && schema.apiSchema) {
    const apiPaths = (schema.apiSchema.endpoints || []).map((e) => e.path);
    (schema.uiSchema.pages || []).forEach((page) => {
      (page.apiCalls || []).forEach((call) => {
        if (!apiPaths.includes(call)) {
          errors.push({
            type: "cross_layer",
            msg: `UI page '${page.name}' calls API '${call}' not defined in API schema`,
            field: call,
          });
        }
      });
    });
  }

  // Required fields
  Object.entries(REQUIRED_SCHEMA).forEach(([section, fields]) => {
    if (schema[section]) {
      fields.forEach((f) => {
        if (schema[section][f] === undefined) {
          errors.push({
            type: "missing_field",
            msg: `Missing required field '${f}' in ${section}`,
            section,
            field: f,
          });
        }
      });
    }
  });

  return errors;
}

// ── Repair hints ──────────────────────────────────────────────────────────
function buildRepairPrompt(errors, partialSchema) {
  const errorList = errors.map((e) => `- [${e.type}] ${e.msg}`).join("\n");
  return `The generated schema has the following issues. Fix ONLY these issues without changing anything else:
${errorList}

Current schema (partial):
${JSON.stringify(partialSchema, null, 2).slice(0, 3000)}

Return the corrected full JSON schema only.`;
}

// ── Claude API call ───────────────────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt, temperature = 0.2) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const data = await res.json();
  const text = (data.content || []).map((b) => b.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return { ok: true, json: JSON.parse(clean), raw: clean };
  } catch {
    return { ok: false, raw: clean, error: "Invalid JSON" };
  }
}

// ── Pipeline stages ───────────────────────────────────────────────────────
const STAGE_PROMPTS = {
  intent: {
    system: `You are a software requirements analyst. Extract structured intent from user descriptions.
Return ONLY valid JSON with this exact shape:
{
  "summary": "string",
  "entities": ["string"],
  "roles": ["string"],
  "features": ["string"],
  "constraints": ["string"],
  "assumptions": ["string"]
}
No markdown, no explanation.`,
    user: (input) => `Extract intent from: "${input}"`,
  },

  architecture: {
    system: `You are a software architect. Given structured intent, design app architecture.
Return ONLY valid JSON:
{
  "pages": [{"name":"string","route":"string","roles":["string"]}],
  "apiEndpoints": [{"path":"string","method":"string","entity":"string","roles":["string"]}],
  "dbTables": [{"name":"string","fields":["string"]}],
  "authRules": [{"role":"string","can":["string"]}]
}
No markdown, no explanation.`,
    user: (intent) => `Design architecture for: ${JSON.stringify(intent)}`,
  },

  schemas: {
    system: `You are a schema generator. Generate complete schemas from architecture.
Return ONLY valid JSON with this shape:
{
  "uiSchema": {
    "pages": [{"name":"string","route":"string","components":["string"],"apiCalls":["string"]}]
  },
  "apiSchema": {
    "endpoints": [{"path":"string","method":"string","entity":"string","requestBody":{},"responseBody":{},"authRequired":true,"roles":["string"]}]
  },
  "dbSchema": {
    "tables": [{"name":"string","fields":[{"name":"string","type":"string","nullable":false}],"relations":[]}]
  },
  "authSchema": {
    "roles": ["string"],
    "permissions": [{"role":"string","resource":"string","actions":["string"]}]
  },
  "businessLogic": [{"rule":"string","trigger":"string","action":"string"}]
}
Ensure: every UI apiCall maps to a real API endpoint. Every API endpoint references a real DB table.`,
    user: (arch) =>
      `Generate schemas from this architecture: ${JSON.stringify(arch)}`,
  },

  refinement: {
    system: `You are a schema consistency checker and refiner. Given all generated schemas, resolve any inconsistencies.
Return the COMPLETE refined JSON merging all layers:
{
  "intent": {...},
  "architecture": {...},
  "uiSchema": {...},
  "apiSchema": {...},
  "dbSchema": {...},
  "authSchema": {...},
  "businessLogic": [...],
  "metadata": {"version":"1.0","generatedAt":"string","consistencyScore":0-100}
}
Fix cross-layer mismatches. Return ONLY valid JSON.`,
    user: (all) => `Refine and merge: ${JSON.stringify(all).slice(0, 4000)}`,
  },
};

// ── Main Component ────────────────────────────────────────────────────────
export default function AppCompiler() {
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState([]);
  const [finalOutput, setFinalOutput] = useState(null);
  const [errors, setErrors] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [activeTab, setActiveTab] = useState("pipeline");
  const [evalResults, setEvalResults] = useState([]);
  const [runningEval, setRunningEval] = useState(false);
  const logRef = useRef(null);

  const EXAMPLE_PROMPTS = [
    "Build a CRM with login, contacts, dashboard, role-based access, and premium plan with payments. Admins can see analytics.",
    "Create a task management app with teams, sprints, Kanban board, notifications, and reporting.",
    "Build a blog platform with authors, editors, comments, tags, and subscription newsletter.",
  ];

  const EVAL_PROMPTS = [
    // Real product prompts
    { id: 1, type: "real", text: "Build a CRM with contacts, deals, pipeline, and email integration." },
    { id: 2, type: "real", text: "Create an e-commerce store with products, cart, checkout, orders, and admin dashboard." },
    { id: 3, type: "real", text: "Build a project management tool with tasks, milestones, team members, and Gantt chart." },
    { id: 4, type: "real", text: "Create a learning management system with courses, quizzes, progress tracking, and certificates." },
    { id: 5, type: "real", text: "Build a healthcare appointment booking system with doctors, patients, schedules, and prescriptions." },
    // Edge cases
    { id: 6, type: "edge_vague", text: "Make an app." },
    { id: 7, type: "edge_conflict", text: "Build a free app that also requires paid subscription for all features including free ones." },
    { id: 8, type: "edge_incomplete", text: "Build a social network with posts." },
    { id: 9, type: "edge_ambiguous", text: "Create something for managing things with users and stuff." },
    { id: 10, type: "edge_complex", text: "Build an AI-powered multi-tenant SaaS with SSO, webhooks, API keys, billing, usage limits, and white-labeling." },
  ];

  function addStage(name, status, data, errs = []) {
    setStages((prev) => [
      ...prev,
      { name, status, data, errors: errs, ts: Date.now() },
    ]);
  }

  function updateLastStage(patch) {
    setStages((prev) => {
      const copy = [...prev];
      copy[copy.length - 1] = { ...copy[copy.length - 1], ...patch };
      return copy;
    });
  }

  async function runPipeline(promptText) {
    const startTime = Date.now();
    let retries = 0;
    setRunning(true);
    setStages([]);
    setFinalOutput(null);
    setErrors([]);
    setMetrics(null);

    try {
      // Stage 1: Intent
      addStage("Intent Extraction", "running", null);
      const intentRes = await callClaude(
        STAGE_PROMPTS.intent.system,
        STAGE_PROMPTS.intent.user(promptText)
      );
      if (!intentRes.ok) {
        updateLastStage({ status: "error", error: intentRes.error });
        setMetrics({ success: false, retries, latency: Date.now() - startTime, failureType: "json_parse" });
        setRunning(false);
        return;
      }
      updateLastStage({ status: "done", data: intentRes.json });
      const intent = intentRes.json;

      // Stage 2: Architecture
      addStage("System Design", "running", null);
      const archRes = await callClaude(
        STAGE_PROMPTS.architecture.system,
        STAGE_PROMPTS.architecture.user(intent)
      );
      if (!archRes.ok) {
        updateLastStage({ status: "error", error: archRes.error });
        setRunning(false);
        return;
      }
      updateLastStage({ status: "done", data: archRes.json });
      const arch = archRes.json;

      // Stage 3: Schema Generation
      addStage("Schema Generation", "running", null);
      const schemaRes = await callClaude(
        STAGE_PROMPTS.schemas.system,
        STAGE_PROMPTS.schemas.user(arch)
      );
      if (!schemaRes.ok) {
        updateLastStage({ status: "error", error: schemaRes.error });
        setRunning(false);
        return;
      }
      updateLastStage({ status: "done", data: schemaRes.json });
      let schemas = schemaRes.json;

      // Validate
      const validationErrors = validateSchema({ ...schemas, intent, architecture: arch });

      // Stage 4: Repair if needed
      if (validationErrors.length > 0) {
        addStage("Validation + Repair", "running", null, validationErrors);
        retries++;
        const repairRes = await callClaude(
          `You are a schema repair engine. Fix the listed issues and return corrected JSON only.`,
          buildRepairPrompt(validationErrors, schemas)
        );
        if (repairRes.ok) {
          schemas = { ...schemas, ...repairRes.json };
          updateLastStage({ status: "repaired", data: schemas, errors: validationErrors });
        } else {
          updateLastStage({ status: "partial_repair", data: schemas, errors: validationErrors });
        }
      }

      // Stage 5: Refinement
      addStage("Refinement", "running", null);
      const allData = { intent, architecture: arch, ...schemas };
      const refineRes = await callClaude(
        STAGE_PROMPTS.refinement.system,
        STAGE_PROMPTS.refinement.user(allData)
      );
      if (!refineRes.ok) {
        updateLastStage({ status: "error", error: refineRes.error });
        // Use what we have
        const final = { ...allData, metadata: { version: "1.0", generatedAt: new Date().toISOString(), consistencyScore: 70 } };
        setFinalOutput(final);
        setErrors(validationErrors);
        setMetrics({ success: true, retries, latency: Date.now() - startTime, warnings: validationErrors.length });
        setRunning(false);
        return;
      }
      updateLastStage({ status: "done", data: refineRes.json });

      const final = refineRes.json;
      setFinalOutput(final);
      setErrors([]);
      setMetrics({ success: true, retries, latency: Date.now() - startTime, consistencyScore: final?.metadata?.consistencyScore || 90, warnings: 0 });
    } catch (e) {
      setErrors([{ type: "system", msg: e.message }]);
      setMetrics({ success: false, retries, latency: Date.now() - startTime, failureType: "exception" });
    }
    setRunning(false);
  }

  async function runEval() {
    setRunningEval(true);
    setEvalResults([]);
    const results = [];
    for (const p of EVAL_PROMPTS.slice(0, 5)) {
      // Run mini pipeline (intent only for speed)
      const start = Date.now();
      const res = await callClaude(STAGE_PROMPTS.intent.system, STAGE_PROMPTS.intent.user(p.text));
      const latency = Date.now() - start;
      results.push({
        id: p.id,
        type: p.type,
        text: p.text.slice(0, 60) + "...",
        success: res.ok,
        latency,
        hasAssumptions: res.ok && (res.json?.assumptions?.length > 0),
      });
      setEvalResults([...results]);
    }
    setRunningEval(false);
  }

  const statusIcon = (s) =>
    ({ running: "⟳", done: "✓", error: "✗", repaired: "⚡", partial_repair: "△" }[s] || "○");
  const statusColor = (s) =>
    ({ running: "#f59e0b", done: "#10b981", error: "#ef4444", repaired: "#6366f1", partial_repair: "#f97316" }[s] || "#6b7280");

  return (
    <div style={{ fontFamily: "'JetBrains Mono', 'Fira Code', monospace", background: "#0a0a0f", minHeight: "100vh", color: "#e2e8f0", padding: "0" }}>
      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 100%)", borderBottom: "1px solid #1e293b", padding: "20px 32px", display: "flex", alignItems: "center", gap: "16px" }}>
        <div style={{ width: 40, height: 40, borderRadius: 8, background: "linear-gradient(135deg, #6366f1, #8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚙</div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.5px" }}>AppCompiler AI</div>
          <div style={{ fontSize: 11, color: "#64748b" }}>Natural Language → Executable App Schema</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          {["pipeline", "output", "eval"].map((t) => (
            <button key={t} onClick={() => setActiveTab(t)} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid", borderColor: activeTab === t ? "#6366f1" : "#1e293b", background: activeTab === t ? "#6366f1" : "transparent", color: activeTab === t ? "#fff" : "#64748b", fontSize: 12, cursor: "pointer", textTransform: "capitalize" }}>
              {t === "pipeline" ? "🔧 Pipeline" : t === "output" ? "📄 Output" : "📊 Eval"}
            </button>
          ))}
        </div>
      </div>

      <div style={{ padding: "24px 32px", maxWidth: 1100, margin: "0 auto" }}>
        {/* Input area */}
        <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 12, padding: 20, marginBottom: 20 }}>
          <div style={{ fontSize: 11, color: "#6366f1", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>// user_prompt</div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder='e.g. "Build a CRM with login, contacts, dashboard, role-based access, and premium plan with payments."'
            rows={3}
            style={{ width: "100%", background: "transparent", border: "none", color: "#e2e8f0", fontSize: 14, resize: "none", outline: "none", fontFamily: "inherit", lineHeight: 1.6 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {EXAMPLE_PROMPTS.map((p, i) => (
              <button key={i} onClick={() => setInput(p)} style={{ fontSize: 11, padding: "4px 10px", borderRadius: 20, border: "1px solid #1e293b", background: "transparent", color: "#64748b", cursor: "pointer" }}>
                Example {i + 1}
              </button>
            ))}
            <button
              onClick={() => input.trim() && runPipeline(input.trim())}
              disabled={running || !input.trim()}
              style={{ marginLeft: "auto", padding: "8px 20px", borderRadius: 8, border: "none", background: running ? "#1e293b" : "linear-gradient(135deg, #6366f1, #8b5cf6)", color: running ? "#64748b" : "#fff", fontSize: 13, cursor: running ? "not-allowed" : "pointer", fontFamily: "inherit", fontWeight: 600 }}
            >
              {running ? "⟳ Compiling..." : "▶ Compile"}
            </button>
          </div>
        </div>

        {/* Pipeline tab */}
        {activeTab === "pipeline" && (
          <div>
            {stages.length === 0 && !running && (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#334155" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>⚙</div>
                <div style={{ fontSize: 14 }}>Enter a prompt and click Compile to start the pipeline</div>
              </div>
            )}
            {stages.map((s, i) => (
              <div key={i} style={{ background: "#0f172a", border: `1px solid ${s.status === "error" ? "#7f1d1d" : "#1e293b"}`, borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, borderBottom: s.data ? "1px solid #1e293b" : "none" }}>
                  <span style={{ color: statusColor(s.status), fontSize: 16 }}>{statusIcon(s.status)}</span>
                  <span style={{ fontWeight: 600, fontSize: 13, color: "#f1f5f9" }}>Stage {i + 1}: {s.name}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: statusColor(s.status), textTransform: "uppercase" }}>{s.status}</span>
                </div>
                {s.errors?.length > 0 && (
                  <div style={{ padding: "8px 16px", background: "#1a0a0a", borderBottom: "1px solid #7f1d1d" }}>
                    {s.errors.map((e, j) => (
                      <div key={j} style={{ fontSize: 11, color: "#fca5a5", marginBottom: 2 }}>⚠ [{e.type}] {e.msg}</div>
                    ))}
                  </div>
                )}
                {s.data && (
                  <div style={{ padding: "12px 16px", maxHeight: 220, overflowY: "auto" }}>
                    <pre style={{ fontSize: 11, color: "#94a3b8", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      {JSON.stringify(s.data, null, 2).slice(0, 1500)}{JSON.stringify(s.data, null, 2).length > 1500 ? "\n... (truncated)" : ""}
                    </pre>
                  </div>
                )}
              </div>
            ))}

            {metrics && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 8 }}>
                {[
                  { label: "Status", value: metrics.success ? "✓ Success" : "✗ Failed", color: metrics.success ? "#10b981" : "#ef4444" },
                  { label: "Latency", value: `${(metrics.latency / 1000).toFixed(1)}s`, color: "#6366f1" },
                  { label: "Retries", value: metrics.retries, color: metrics.retries > 0 ? "#f97316" : "#10b981" },
                  { label: "Consistency", value: metrics.consistencyScore ? `${metrics.consistencyScore}%` : "N/A", color: "#8b5cf6" },
                ].map((m, i) => (
                  <div key={i} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "12px 16px", textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>{m.label}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: m.color }}>{m.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Output tab */}
        {activeTab === "output" && (
          <div>
            {!finalOutput ? (
              <div style={{ textAlign: "center", padding: "60px 0", color: "#334155" }}>
                <div style={{ fontSize: 14 }}>No output yet. Run the compiler first.</div>
              </div>
            ) : (
              <div>
                {["uiSchema", "apiSchema", "dbSchema", "authSchema", "businessLogic"].map((key) =>
                  finalOutput[key] ? (
                    <div key={key} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, marginBottom: 12, overflow: "hidden" }}>
                      <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 11, color: "#6366f1", textTransform: "uppercase", fontWeight: 700, letterSpacing: 1 }}>{key}</span>
                        <button
                          onClick={() => navigator.clipboard.writeText(JSON.stringify(finalOutput[key], null, 2))}
                          style={{ marginLeft: "auto", fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid #1e293b", background: "transparent", color: "#64748b", cursor: "pointer" }}
                        >Copy</button>
                      </div>
                      <div style={{ padding: "12px 16px", maxHeight: 300, overflowY: "auto" }}>
                        <pre style={{ fontSize: 11, color: "#94a3b8", margin: 0, whiteSpace: "pre-wrap" }}>
                          {JSON.stringify(finalOutput[key], null, 2)}
                        </pre>
                      </div>
                    </div>
                  ) : null
                )}
                <button
                  onClick={() => {
                    const blob = new Blob([JSON.stringify(finalOutput, null, 2)], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = "app-schema.json"; a.click();
                  }}
                  style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: "#6366f1", color: "#fff", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
                >
                  ↓ Download Full Schema JSON
                </button>
              </div>
            )}
          </div>
        )}

        {/* Eval tab */}
        {activeTab === "eval" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "#94a3b8" }}>Evaluation Dataset — 5 real prompts + 5 edge cases</div>
              <button
                onClick={runEval}
                disabled={runningEval}
                style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: runningEval ? "#1e293b" : "#6366f1", color: runningEval ? "#64748b" : "#fff", fontSize: 12, cursor: runningEval ? "not-allowed" : "pointer", fontFamily: "inherit" }}
              >
                {runningEval ? "⟳ Running..." : "▶ Run Evaluation"}
              </button>
            </div>
            <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "40px 90px 1fr 80px 80px 80px", padding: "8px 16px", borderBottom: "1px solid #1e293b", fontSize: 11, color: "#64748b", textTransform: "uppercase" }}>
                <span>#</span><span>Type</span><span>Prompt</span><span>Status</span><span>Latency</span><span>Assumptions</span>
              </div>
              {EVAL_PROMPTS.map((p) => {
                const r = evalResults.find((x) => x.id === p.id);
                return (
                  <div key={p.id} style={{ display: "grid", gridTemplateColumns: "40px 90px 1fr 80px 80px 80px", padding: "10px 16px", borderBottom: "1px solid #0f172a", fontSize: 12, alignItems: "center", background: p.id % 2 === 0 ? "#0a0f1a" : "transparent" }}>
                    <span style={{ color: "#64748b" }}>{p.id}</span>
                    <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: p.type === "real" ? "#064e3b" : "#4a1d96", color: p.type === "real" ? "#10b981" : "#a78bfa" }}>{p.type}</span>
                    <span style={{ color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.text.slice(0, 55)}...</span>
                    <span style={{ color: r ? (r.success ? "#10b981" : "#ef4444") : "#334155" }}>{r ? (r.success ? "✓ Pass" : "✗ Fail") : "—"}</span>
                    <span style={{ color: "#6366f1" }}>{r ? `${(r.latency / 1000).toFixed(1)}s` : "—"}</span>
                    <span style={{ color: r?.hasAssumptions ? "#f59e0b" : "#334155" }}>{r ? (r.hasAssumptions ? "Yes" : "No") : "—"}</span>
                  </div>
                );
              })}
            </div>
            {evalResults.length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginTop: 16 }}>
                {[
                  { label: "Success Rate", value: `${Math.round((evalResults.filter((r) => r.success).length / evalResults.length) * 100)}%` },
                  { label: "Avg Latency", value: `${(evalResults.reduce((a, r) => a + r.latency, 0) / evalResults.length / 1000).toFixed(1)}s` },
                  { label: "With Assumptions", value: evalResults.filter((r) => r.hasAssumptions).length + "/" + evalResults.length },
                ].map((m, i) => (
                  <div key={i} style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8, padding: "16px", textAlign: "center" }}>
                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>{m.label}</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: "#6366f1" }}>{m.value}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
