document.addEventListener("DOMContentLoaded", () => {
  const timeElement = document.getElementById("time");
  const todoListElement = document.getElementById("todo-list");
  const newTodoInput = document.getElementById("new-todo-input");
  const addTodoButton = document.getElementById("add-todo-button");
  const nameInput = document.getElementById("name-input");
  const newGroupInput = document.getElementById("new-group-input");
  const groupTabs = document.getElementById("group-tabs");

  let selectedGroup = "";

  // -----------------------------
  // Consolidated Storage + Sync
  // -----------------------------
  const STATE_KEY = "app_state_v1";                 // single source of truth
  const SYNC_CONFIG_KEY = "sync_config_v1";         // { base, syncId, token }
  const DIRTY_KEY = "sync_dirty";                   // local changes pending push

  // Network sync gating: at most once/day (attempt-based). Use manual sync icon if needed.
  const LAST_SYNC_ATTEMPT_KEY = "last_sync_attempt_ms";
  const LAST_SYNC_SUCCESS_KEY = "last_sync_success_ms";
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

  // Best-effort lock so multiple tabs don't sync together
  const SYNC_LOCK_KEY = "sync_lock_until_ms";
  const SYNC_LOCK_TTL_MS = 2 * 60 * 1000; // 2 min

  // Task ID generation (monotonic on this device)
  const LAST_TASK_ID_KEY = "last_task_id_ms";

  let appState = {
    todos: [],
    deleted_task_ids: {}, // { [task_id]: deletedAtMs }
    selected_group: "",
    user_name: "",
    updatedAt: 0,
  };

  // -----------------------------
  // Sync Icon (top-right, white)
  // -----------------------------
  const syncIconBtn = document.createElement("button");
  syncIconBtn.type = "button";
  syncIconBtn.setAttribute("aria-label", "Sync now");
  syncIconBtn.title = "Sync now";

  syncIconBtn.style.position = "fixed";
  syncIconBtn.style.top = "14px";
  syncIconBtn.style.right = "14px";
  syncIconBtn.style.background = "transparent";
  syncIconBtn.style.border = "none";
  syncIconBtn.style.padding = "6px";
  syncIconBtn.style.cursor = "pointer";
  syncIconBtn.style.zIndex = "9999";
  syncIconBtn.style.opacity = "0.9";

//  Cloud sync vibe (sync arrows + tiny cloud shape)
syncIconBtn.innerHTML = `
  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path fill="#ffffff" d="M19.35 10.04A7 7 0 0 0 5.09 8.87 4.5 4.5 0 0 0 5.5 18H10v-2H5.5A2.5 2.5 0 0 1 5 11.05l.15-.02.92-.12.34-.86A5 5 0 0 1 16.9 11l.1 1h1A2.5 2.5 0 0 1 18.5 17H18v2h.5A4.5 4.5 0 0 0 19.35 10.04Z"/>
    <path fill="#ffffff" d="M14 13v-2l-3 3 3 3v-2h4v-2h-4Z"/>
  </svg>
`;

  const syncStatus = document.createElement("div");
  syncStatus.style.position = "fixed";
  syncStatus.style.top = "42px";
  syncStatus.style.right = "14px";
  syncStatus.style.fontSize = "12px";
  syncStatus.style.opacity = "0.85";
  syncStatus.style.zIndex = "9999";
  syncStatus.style.pointerEvents = "none";
  syncStatus.textContent = "";

  document.body.appendChild(syncIconBtn);
  document.body.appendChild(syncStatus);

  function setStatus(msg, { clearAfterMs = 0 } = {}) {
    syncStatus.textContent = msg || "";
    if (clearAfterMs > 0) {
      setTimeout(() => {
        if (syncStatus.textContent === msg) syncStatus.textContent = "";
      }, clearAfterMs);
    }
  }

  // -----------------------------
  // Helpers
  // -----------------------------
  function nowMs() {
    return Date.now();
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  function toMs(x) {
    const n = Number(x);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function normalizeTodos(todos) {
    const arr = Array.isArray(todos) ? todos : [];
    const out = [];
    for (const t of arr) {
      const task = String(t?.task ?? "").trim();
      if (!task) continue;

      const task_id = toMs(t?.task_id); // may be 0 during migration; fixed later
      const group = String(t?.group ?? "").trim();
      const status = (t?.status === "completed") ? "completed" : "pending";
      const task_updated_at = toMs(t?.task_updated_at) || task_id || 0;

      out.push({ task_id, task, group, status, task_updated_at });
    }
    return out;
  }

  function normalizeDeletedMap(x) {
    if (!x || typeof x !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      const id = toMs(k);
      const deletedAt = toMs(v);
      if (id && deletedAt) out[String(id)] = deletedAt;
    }
    return out;
  }

  function rerenderFromState() {
    selectedGroup = appState.selected_group || "";
    if (newGroupInput) {
      newGroupInput.placeholder = selectedGroup ? `Group: ${selectedGroup}` : "Group (optional)";
    }
    nameInput.value = appState.user_name || "";
    renderTabsFromTodos(appState.todos || []);
    displayTodos(appState.todos || []);
  }

  // -----------------------------
  // Task ID generation
  // -----------------------------
  let lastGeneratedTaskId = 0;

  async function initLastTaskId() {
    const r = await storageGet([LAST_TASK_ID_KEY]);
    lastGeneratedTaskId = Math.max(lastGeneratedTaskId, toMs(r[LAST_TASK_ID_KEY]));
  }

  async function generateTaskId() {
    let id = nowMs();
    if (id <= lastGeneratedTaskId) id = lastGeneratedTaskId + 1;
    lastGeneratedTaskId = id;
    await storageSet({ [LAST_TASK_ID_KEY]: id });
    return id;
  }

  // -----------------------------
  // Consolidated State IO (Local)
  // -----------------------------
  async function loadState() {
    // Backward compatibility: import old per-key storage if consolidated missing
    const r = await storageGet([STATE_KEY, "todos", "selected_group", "user_name"]);

    let st = r[STATE_KEY];

    if (!st || typeof st !== "object") {
      st = {
        todos: normalizeTodos(r.todos || []),
        deleted_task_ids: {},
        selected_group: typeof r.selected_group === "string" ? r.selected_group : "",
        user_name: typeof r.user_name === "string" ? r.user_name : "",
        updatedAt: 0,
      };
    } else {
      st = {
        todos: normalizeTodos(st.todos || []),
        deleted_task_ids: normalizeDeletedMap(st.deleted_task_ids),
        selected_group: typeof st.selected_group === "string" ? st.selected_group : "",
        user_name: typeof st.user_name === "string" ? st.user_name : "",
        updatedAt: toMs(st.updatedAt),
      };
    }

    appState = st;
    selectedGroup = st.selected_group || "";
  }

  async function persistState({ markDirty = false } = {}) {
    appState.updatedAt = nowMs();

    // Write consolidated + mirror legacy keys (so old debug expectations still work)
    const payload = {
      [STATE_KEY]: appState,
      todos: appState.todos,
      selected_group: appState.selected_group,
      user_name: appState.user_name,
    };

    if (markDirty) payload[DIRTY_KEY] = true;

    await storageSet(payload);
  }

  async function migrateStateIfNeeded() {
    let changed = false;

    if (!appState.deleted_task_ids || typeof appState.deleted_task_ids !== "object") {
      appState.deleted_task_ids = {};
      changed = true;
    }

    // Ensure every todo has task_id and task_updated_at
    for (const t of appState.todos) {
      if (!toMs(t.task_id)) {
        t.task_id = await generateTaskId();
        changed = true;
      }
      if (!toMs(t.task_updated_at)) {
        t.task_updated_at = toMs(t.task_id) || nowMs();
        changed = true;
      }
    }

    // Sort deterministically by creation time
    appState.todos.sort((a, b) => toMs(a.task_id) - toMs(b.task_id));

    if (changed) {
      await persistState({ markDirty: true });
    }
  }

  // -----------------------------
  // Remote Sync (Cloudflare Worker merge)
  // -----------------------------
  async function getSyncConfig() {
    const r = await storageGet([SYNC_CONFIG_KEY]);
    const cfg = r[SYNC_CONFIG_KEY];
    if (!cfg || typeof cfg !== "object") return null;

    const base = typeof cfg.base === "string" ? cfg.base.trim().replace(/\/+$/, "") : "";
    const syncId = typeof cfg.syncId === "string" ? cfg.syncId.trim() : "";
    const token = typeof cfg.token === "string" ? cfg.token.trim() : "";

    if (!base || !syncId || !token) return null;
    return { base, syncId, token };
  }

  async function shouldAttemptSyncNow() {
    const r = await storageGet([LAST_SYNC_ATTEMPT_KEY]);
    const lastAttempt = toMs(r[LAST_SYNC_ATTEMPT_KEY]);
    return (nowMs() - lastAttempt) >= SYNC_INTERVAL_MS;
  }

  async function markSyncAttempt() {
    await storageSet({ [LAST_SYNC_ATTEMPT_KEY]: nowMs() });
  }

  async function markSyncSuccess() {
    await storageSet({
      [LAST_SYNC_SUCCESS_KEY]: nowMs(),
      [DIRTY_KEY]: false,
    });
  }

  async function acquireSyncLock() {
    const r = await storageGet([SYNC_LOCK_KEY]);
    const lockUntil = toMs(r[SYNC_LOCK_KEY]);
    if (lockUntil > nowMs()) return false;
    await storageSet({ [SYNC_LOCK_KEY]: nowMs() + SYNC_LOCK_TTL_MS });
    return true;
  }

  async function releaseSyncLock() {
    await storageSet({ [SYNC_LOCK_KEY]: 0 });
  }

  async function remoteGet(cfg) {
    const url = `${cfg.base}/v1/blob/${encodeURIComponent(cfg.syncId)}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}` },
    });

    if (resp.status === 401) throw new Error("unauthorized (token mismatch)");
    if (!resp.ok) throw new Error(`GET failed: ${resp.status}`);

    return await resp.json(); // null OR { updatedAt, data }
  }

  async function remotePutMerge(cfg, payload) {
    const url = `${cfg.base}/v1/blob/${encodeURIComponent(cfg.syncId)}`;
    const resp = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (resp.status === 401) throw new Error("unauthorized (token mismatch)");
    if (!resp.ok) throw new Error(`PUT failed: ${resp.status}`);

    // Worker returns merged blob
    return await resp.json();
  }

  async function applyRemoteBlob(remote, { force = false } = {}) {
    if (!remote || typeof remote !== "object") return false;

    const remoteUpdatedAt = toMs(remote.updatedAt);
    const remoteData = remote.data;

    if (!remoteUpdatedAt || !remoteData || typeof remoteData !== "object") return false;
    if (!force && remoteUpdatedAt <= toMs(appState.updatedAt)) return false;

    const todos = normalizeTodos(remoteData.todos || []);
    const deleted = normalizeDeletedMap(remoteData.deleted_task_ids);

    // Drop deleted tasks locally too (server should already do it, but keep safe)
    const filtered = [];
    for (const t of todos) {
      const id = toMs(t.task_id);
      const delAt = toMs(deleted[String(id)]);
      const score = toMs(t.task_updated_at) || id;
      if (delAt && delAt >= score) continue;
      filtered.push(t);
    }
    filtered.sort((a, b) => toMs(a.task_id) - toMs(b.task_id));

    appState = {
      todos: filtered,
      deleted_task_ids: deleted,
      selected_group: typeof remoteData.selected_group === "string" ? remoteData.selected_group : "",
      user_name: typeof remoteData.user_name === "string" ? remoteData.user_name : "",
      updatedAt: remoteUpdatedAt,
    };

    selectedGroup = appState.selected_group || "";

    await storageSet({
      [STATE_KEY]: appState,
      todos: appState.todos,
      selected_group: appState.selected_group,
      user_name: appState.user_name,
      [DIRTY_KEY]: false,
    });

    return true;
  }

  async function syncMaybe({ force = false } = {}) {
    if (!force) {
      const ok = await shouldAttemptSyncNow();
      if (!ok) return { ran: false, message: "" };
    }

    const locked = await acquireSyncLock();
    if (!locked) return { ran: false, message: "Sync already running" };

    try {
      await markSyncAttempt();

      const cfg = await getSyncConfig();
      if (!cfg) return { ran: true, message: "Sync not configured" };

      const dirtyRes = await storageGet([DIRTY_KEY]);
      const localDirty = !!dirtyRes[DIRTY_KEY];

      // 1) Pull remote (optional but useful before push)
      try {
        const remote = await remoteGet(cfg);
        if (remote) {
          const applied = await applyRemoteBlob(remote, { force: false });
          if (applied) rerenderFromState();
        }
      } catch (e) {
        return { ran: true, message: `Sync failed: ${e?.message || e}` };
      }

      // 2) Push local if dirty (server merges and returns merged state)
      if (localDirty) {
        const payload = {
          updatedAt: toMs(appState.updatedAt) || nowMs(),
          data: {
            todos: appState.todos || [],
            deleted_task_ids: appState.deleted_task_ids || {},
            selected_group: appState.selected_group || "",
            user_name: appState.user_name || "",
          },
        };

        try {
          const merged = await remotePutMerge(cfg, payload);
          const appliedMerged = await applyRemoteBlob(merged, { force: true });
          if (appliedMerged) rerenderFromState();
        } catch (e) {
          return { ran: true, message: `Sync failed: ${e?.message || e}` };
        }
      }

      await markSyncSuccess();
      return { ran: true, message: "Synced" };
    } finally {
      await releaseSyncLock();
    }
  }

  syncIconBtn.addEventListener("click", async () => {
    syncIconBtn.disabled = true;
    syncIconBtn.style.opacity = "0.6";
    setStatus("Syncing...");

    const res = await syncMaybe({ force: true });
    if (res?.message) setStatus(res.message, { clearAfterMs: 2500 });
    else setStatus("Done", { clearAfterMs: 1500 });

    syncIconBtn.disabled = false;
    syncIconBtn.style.opacity = "0.9";
  });

  // ---- ⏰ TIME ----
  function updateTime() {
    timeElement.textContent = new Date().toLocaleTimeString();
  }
  setInterval(updateTime, 1000);
  updateTime();

  // -----------------------------
  // Your app logic (now with task_id + tombstones)
  // -----------------------------
  async function getTodosFromStorage() {
    return appState.todos || [];
  }

  async function saveTodosToStorage(todos) {
    appState.todos = normalizeTodos(todos);
    appState.todos.sort((a, b) => toMs(a.task_id) - toMs(b.task_id));
    await persistState({ markDirty: true });
  }

  async function getSelectedGroupFromStorage() {
    return typeof appState.selected_group === "string" ? appState.selected_group : "";
  }

  async function saveSelectedGroupToStorage(groupName) {
    appState.selected_group = (groupName || "").trim();
    await persistState({ markDirty: true });
  }

  async function getUserNameFromStorage() {
    return typeof appState.user_name === "string" ? appState.user_name : "";
  }

  async function saveUserNameToStorage(userName) {
    appState.user_name = (userName || "").trim();
    await persistState({ markDirty: true });
  }

  function renderTabsFromTodos(todos) {
    groupTabs.innerHTML = "";

    const groupSet = new Set([""]);
    todos.forEach((t) => groupSet.add((t.group || "").trim()));
    groupSet.add((selectedGroup || "").trim());

    const groups = Array.from(groupSet).sort((a, b) => {
      if (a && b) return a.localeCompare(b);
      if (a && !b) return 1;
      if (!a && b) return -1;
      return 0;
    });

    groups.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "group-tab" + (g === selectedGroup ? " active" : "");
      btn.textContent = g || "Ungrouped";
      btn.addEventListener("click", async () => {
        selectedGroup = g;
        await saveSelectedGroupToStorage(selectedGroup);

        if (newGroupInput) newGroupInput.placeholder = g ? `Group: ${g}` : "Group (optional)";
        const todosNow = await getTodosFromStorage();
        renderTabsFromTodos(todosNow);
        displayTodos(todosNow);
      });
      groupTabs.appendChild(btn);
    });
  }

  function displayTodos(todos) {
    todoListElement.innerHTML = "";

    const filtered = todos.filter(
      (t) => (t.group || "").trim() === (selectedGroup || "").trim()
    );

    filtered.forEach((todo) => {
      const indexInAll = todos.indexOf(todo);

      const todoItem = document.createElement("div");
      todoItem.className = "todo-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.style.transform = "scale(1.5)";
      checkbox.checked = todo.status === "completed";
      checkbox.addEventListener("change", async () => {
        todos[indexInAll].status = checkbox.checked ? "completed" : "pending";
        todos[indexInAll].task_updated_at = nowMs();
        await saveTodosToStorage(todos);
        displayTodos(todos);
      });

      const task = document.createElement("span");
      task.textContent = todo.task;
      task.style.textDecoration = checkbox.checked ? "line-through" : "none";

      const deleteButton = document.createElement("button");
      deleteButton.textContent = "❌";
      deleteButton.style.fontSize = "1.2rem";
      deleteButton.style.background = "transparent";
      deleteButton.style.border = "none";
      deleteButton.style.color = "#f00";
      deleteButton.style.cursor = "pointer";
      deleteButton.addEventListener("click", async () => {
        const id = toMs(todos[indexInAll]?.task_id);
        if (id) {
          appState.deleted_task_ids[String(id)] = nowMs(); // tombstone
        }
        todos.splice(indexInAll, 1);
        await saveTodosToStorage(todos);
        await persistState({ markDirty: true });
        renderTabsFromTodos(todos);
        displayTodos(todos);
      });

      todoItem.appendChild(checkbox);
      todoItem.appendChild(task);
      todoItem.appendChild(deleteButton);
      todoListElement.appendChild(todoItem);
    });
  }

  async function initializeTodos() {
    let todos = await getTodosFromStorage();

    if (!todos.length) {
      try {
        const response = await fetch("todo.json");
        const seed = await response.json();
        const normalized = normalizeTodos(seed);

        // Assign task_id for seeded tasks
        for (const t of normalized) {
          if (!toMs(t.task_id)) {
            t.task_id = await generateTaskId();
            t.task_updated_at = toMs(t.task_id);
          }
        }

        appState.todos = normalized.sort((a, b) => toMs(a.task_id) - toMs(b.task_id));
        await persistState({ markDirty: true });
        todos = appState.todos;
      } catch (error) {
        console.error("Error fetching todos:", error);
        todos = [];
      }
    }

    selectedGroup = (await getSelectedGroupFromStorage()) || "";
    if (newGroupInput) {
      newGroupInput.placeholder = selectedGroup ? `Group: ${selectedGroup}` : "Group (optional)";
    }

    renderTabsFromTodos(todos);
    displayTodos(todos);
  }

  async function addNewTodo() {
    const newTask = newTodoInput.value.trim();
    if (!newTask) {
      alert("Please enter a valid task!");
      return;
    }

    const typedGroup = newGroupInput ? newGroupInput.value.trim() : "";
    const group = typedGroup || selectedGroup || "";

    const todos = await getTodosFromStorage();

    const id = await generateTaskId();
    todos.push({
      task_id: id,
      task: newTask,
      group,
      status: "pending",
      task_updated_at: id,
    });

    await saveTodosToStorage(todos);

    selectedGroup = group;
    await saveSelectedGroupToStorage(selectedGroup);
    if (newGroupInput) newGroupInput.placeholder = group ? `Group: ${group}` : "Group (optional)";

    newTodoInput.value = "";
    if (newGroupInput) newGroupInput.value = "";

    renderTabsFromTodos(todos);
    displayTodos(todos);
  }

  addTodoButton.addEventListener("click", addNewTodo);
  newTodoInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") addNewTodo();
  });
  if (newGroupInput) {
    newGroupInput.addEventListener("keypress", (event) => {
      if (event.key === "Enter") addNewTodo();
    });
  }

  async function setupUserNameInput() {
    const savedName = await getUserNameFromStorage();
    if (savedName) nameInput.value = savedName;

    async function save() {
      const typedName = nameInput.value.trim();
      await saveUserNameToStorage(typedName);
    }

    nameInput.addEventListener("blur", save);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        nameInput.blur();
      }
    });
  }

  // ---- INIT ----
  (async () => {
    await initLastTaskId();
    await loadState();
    await migrateStateIfNeeded();

    await initializeTodos();
    await setupUserNameInput();
    rerenderFromState();

    // Daily auto sync (at most once/day)
    const res = await syncMaybe({ force: false });
    if (res?.message) setStatus(res.message, { clearAfterMs: 1500 });
  })();
});
