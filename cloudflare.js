export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    // Health check (optional, public)
    if (url.pathname === "/") {
      return cors(json({ ok: true, msg: "use /v1/blob/<syncId>" }, 200));
    }

    const m = url.pathname.match(/^\/v1\/blob\/([a-zA-Z0-9_-]{1,100})$/);
    if (!m) return cors(json({ error: "not_found" }, 404));

    // Require auth for blob operations
    const authErr = checkAuth(req, env);
    if (authErr) return cors(authErr);

    const syncId = m[1];
    const key = `blob:${syncId}`;

    if (req.method === "GET") {
      const raw = await env.SCRIBBLE_KV.get(key);
      return cors(
        new Response(raw || "null", {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        })
      );
    }

    if (req.method === "PUT") {
      let incoming;
      try {
        incoming = await req.json(); // expects {updatedAt, data:{...}}
      } catch {
        return cors(json({ error: "invalid_json" }, 400));
      }

      const existingRaw = await env.SCRIBBLE_KV.get(key);
      let existing = null;
      if (existingRaw) {
        try {
          existing = JSON.parse(existingRaw);
        } catch {
          existing = null;
        }
      }

      const merged = mergeBlobs(existing, incoming);

      await env.SCRIBBLE_KV.put(key, JSON.stringify(merged));

      // Return merged to client so it can immediately adopt union set
      return cors(
        new Response(JSON.stringify(merged), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
          },
        })
      );
    }

    return cors(json({ error: "method_not_allowed" }, 405));
  },
};

function checkAuth(req, env) {
  const expected = env.AUTH_TOKEN;
  if (!expected) {
    return json({ error: "server_not_configured", hint: "Set AUTH_TOKEN secret" }, 500);
  }

  const auth = req.headers.get("authorization") || "";
  const x = req.headers.get("x-auth-token") || "";

  const ok = auth === `Bearer ${expected}` || x === expected;
  if (!ok) return json({ error: "unauthorized" }, 401);
  return null;
}

function mergeBlobs(existing, incoming) {
  // Normalize wrappers
  const existingUpdatedAt = toMs(existing?.updatedAt);
  const incomingUpdatedAt = toMs(incoming?.updatedAt);

  const existingData = (existing && typeof existing.data === "object" && existing.data) ? existing.data : {};
  const incomingData = (incoming && typeof incoming.data === "object" && incoming.data) ? incoming.data : {};

  // Deleted map: { [task_id]: deletedAtMs }
  const delA = normalizeDeletedMap(existingData.deleted_task_ids);
  const delB = normalizeDeletedMap(incomingData.deleted_task_ids);
  const deleted = mergeDeletedMaps(delA, delB);

  // Tasks: merge by task_id
  const tasks = new Map(); // task_id -> { todo, score }

  const addTodos = (todos, stateUpdatedAt) => {
    const arr = Array.isArray(todos) ? todos : [];
    for (const t of arr) {
      const todo = normalizeTodo(t, stateUpdatedAt);
      if (!todo) continue;

      const score = todoScore(todo, stateUpdatedAt);
      const prev = tasks.get(todo.task_id);

      if (!prev || score > prev.score) {
        tasks.set(todo.task_id, { todo, score });
      }
    }
  };

  addTodos(existingData.todos, existingUpdatedAt);
  addTodos(incomingData.todos, incomingUpdatedAt);

  // Apply deletions:
  // Deletion wins if deletedAt >= taskScore (handles clock skew / later edits)
  for (const [idStr, deletedAt] of Object.entries(deleted)) {
    const id = Number(idStr);
    const entry = tasks.get(id);
    if (!entry) continue;
    if (deletedAt >= entry.score) tasks.delete(id);
  }

  // Prune old tombstones to avoid growth (90 days)
  const now = Date.now();
  const KEEP_MS = 90 * 24 * 60 * 60 * 1000;
  for (const [idStr, deletedAt] of Object.entries(deleted)) {
    if (now - deletedAt > KEEP_MS) delete deleted[idStr];
  }

  const mergedTodos = Array.from(tasks.values())
    .map((x) => x.todo)
    .sort((a, b) => a.task_id - b.task_id);

  // Meta fields: pick from whichever state updatedAt is newer
  const preferIncoming = incomingUpdatedAt >= existingUpdatedAt;

  const mergedData = {
    todos: mergedTodos,
    deleted_task_ids: deleted,
    selected_group: String(
      (preferIncoming ? incomingData.selected_group : existingData.selected_group) ?? ""
    ),
    user_name: String(
      (preferIncoming ? incomingData.user_name : existingData.user_name) ?? ""
    ),
  };

  // Important: set updatedAt to "now" so other devices know something changed after merge
  const mergedUpdatedAt = Math.max(existingUpdatedAt, incomingUpdatedAt, now);

  return { updatedAt: mergedUpdatedAt, data: mergedData };
}

function normalizeTodo(t, stateUpdatedAt) {
  if (!t || typeof t !== "object") return null;

  const task_id = toMs(t.task_id);
  if (!task_id) return null;

  const task = String(t.task ?? "").trim();
  if (!task) return null;

  const group = String(t.group ?? "").trim();
  const status = (t.status === "completed") ? "completed" : "pending";

  // Optional per-task update timestamp (for conflict resolution)
  const task_updated_at = toMs(t.task_updated_at) || stateUpdatedAt || task_id;

  return { task_id, task, group, status, task_updated_at };
}

function todoScore(todo, stateUpdatedAt) {
  return toMs(todo.task_updated_at) || stateUpdatedAt || toMs(todo.task_id) || 0;
}

function normalizeDeletedMap(x) {
  // Accepts:
  // - object map: { "1765...": 1765... }
  // - array of ids: [1765..., 1765...]  (will be treated as deleted "now")
  if (!x) return {};
  if (Array.isArray(x)) {
    const out = {};
    const now = Date.now();
    for (const v of x) {
      const id = toMs(v);
      if (id) out[String(id)] = now;
    }
    return out;
  }
  if (typeof x === "object") {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      const id = toMs(k);
      const deletedAt = toMs(v) || Date.now();
      if (id) out[String(id)] = deletedAt;
    }
    return out;
  }
  return {};
}

function mergeDeletedMaps(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = Math.max(toMs(prev), toMs(v));
  }
  return out;
}

function toMs(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "GET,PUT,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization,x-auth-token");
  return new Response(resp.body, { status: resp.status, headers: h });
}
