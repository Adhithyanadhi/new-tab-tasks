document.addEventListener("DOMContentLoaded", () => {
  const timeElement = document.getElementById("time");
  const todoListElement = document.getElementById("todo-list");
  const newTodoInput = document.getElementById("new-todo-input");
  const addTodoButton = document.getElementById("add-todo-button");
  const nameInput = document.getElementById("name-input");
  const newGroupInput = document.getElementById("new-group-input");
  const groupTabs = document.getElementById("group-tabs");

  let selectedGroup = ""; // default to Ungrouped

  // -----------------------------
  // Consolidated Storage + Sync
  // -----------------------------
  const STATE_KEY = "app_state_v1";                 // single source of truth
  const SYNC_CONFIG_KEY = "sync_config_v1";         // { base, syncId, token }
  const DIRTY_KEY = "sync_dirty";                   // local changes pending push

  // Gate network sync: at most once per day (attempt-based, so failures won't spam 100 times/day)
  const LAST_SYNC_ATTEMPT_KEY = "last_sync_attempt_ms";
  const LAST_SYNC_SUCCESS_KEY = "last_sync_success_ms";
  const SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

  // Best-effort lock so multiple tabs don't all sync at once
  const SYNC_LOCK_KEY = "sync_lock_until_ms";
  const SYNC_LOCK_TTL_MS = 2 * 60 * 1000; // 2 minutes

  let appState = {
    todos: [],
    selected_group: "",
    user_name: "",
    updatedAt: 0, // ms
  };

  // -----------------------------
  // Force Sync UI (same page)
  // -----------------------------
  const topBar = document.createElement("div");
  topBar.style.display = "flex";
  topBar.style.justifyContent = "space-between";
  topBar.style.alignItems = "center";
  topBar.style.gap = "12px";
  topBar.style.marginBottom = "12px";

  const forceSyncBtn = document.createElement("button");
  forceSyncBtn.textContent = "Sync now";
  forceSyncBtn.style.padding = "8px 12px";
  forceSyncBtn.style.borderRadius = "8px";
  forceSyncBtn.style.border = "1px solid #444";
  forceSyncBtn.style.background = "transparent";
  forceSyncBtn.style.cursor = "pointer";

  const syncStatus = document.createElement("span");
  syncStatus.style.fontSize = "12px";
  syncStatus.style.opacity = "0.85";
  syncStatus.textContent = "";

  topBar.appendChild(forceSyncBtn);
  topBar.appendChild(syncStatus);

  // Insert at top of body (keeps your existing HTML untouched)
  document.body.insertBefore(topBar, document.body.firstChild);

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

  function normalizeTodos(todos) {
    const arr = Array.isArray(todos) ? todos : [];
    return arr
      .map((t) => ({
        task: String(t?.task ?? "").trim(),
        group: String(t?.group ?? "").trim(),
        status: (t?.status === "completed" ? "completed" : "pending"),
      }))
      .filter((t) => t.task.length > 0);
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

  function setStatus(msg, { clearAfterMs = 0 } = {}) {
    syncStatus.textContent = msg || "";
    if (clearAfterMs > 0) {
      setTimeout(() => {
        // don't clear if it changed since
        if (syncStatus.textContent === msg) syncStatus.textContent = "";
      }, clearAfterMs);
    }
  }

  // -----------------------------
  // Consolidated State IO (Local)
  // -----------------------------
  async function loadState() {
    // Migration: if consolidated state doesn't exist, import old keys
    const r = await storageGet([STATE_KEY, "todos", "selected_group", "user_name"]);
    let st = r[STATE_KEY];

    if (!st || typeof st !== "object") {
      st = {
        todos: normalizeTodos(r.todos || []),
        selected_group: typeof r.selected_group === "string" ? r.selected_group : "",
        user_name: typeof r.user_name === "string" ? r.user_name : "",
        updatedAt: 0,
      };
    } else {
      st = {
        todos: normalizeTodos(st.todos || []),
        selected_group: typeof st.selected_group === "string" ? st.selected_group : "",
        user_name: typeof st.user_name === "string" ? st.user_name : "",
        updatedAt: Number(st.updatedAt || 0),
      };
    }

    appState = st;
    selectedGroup = st.selected_group || "";
  }

  async function persistState({ markDirty = false } = {}) {
    appState.updatedAt = nowMs();

    // Write consolidated + mirror legacy keys for compatibility/debugging
    const payload = {
      [STATE_KEY]: appState,
      todos: appState.todos,
      selected_group: appState.selected_group,
      user_name: appState.user_name,
    };

    if (markDirty) payload[DIRTY_KEY] = true;

    await storageSet(payload);
  }

  // -----------------------------
  // Remote Sync (Cloudflare Worker)
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
    const lastAttempt = Number(r[LAST_SYNC_ATTEMPT_KEY] || 0);
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
    const lockUntil = Number(r[SYNC_LOCK_KEY] || 0);
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

    // null OR { updatedAt, data }
    return await resp.json();
  }

  async function remotePut(cfg, payload) {
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
    if (resp.status === 409) return { ok: false, conflict: true };
    if (!resp.ok) throw new Error(`PUT failed: ${resp.status}`);
    return { ok: true };
  }

  async function applyRemoteIfNewer(remote) {
    const remoteUpdatedAt = Number(remote?.updatedAt || 0);
    const remoteData = remote?.data;

    if (!remoteUpdatedAt || !remoteData || typeof remoteData !== "object") return false;
    if (remoteUpdatedAt <= Number(appState.updatedAt || 0)) return false;

    appState = {
      todos: normalizeTodos(remoteData.todos || []),
      selected_group: typeof remoteData.selected_group === "string" ? remoteData.selected_group : "",
      user_name: typeof remoteData.user_name === "string" ? remoteData.user_name : "",
      updatedAt: remoteUpdatedAt,
    };

    selectedGroup = appState.selected_group || "";

    // Write consolidated + mirror keys and clear dirty
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
    // Gate: only once/day (attempt-based) unless forced
    if (!force) {
      const okToAttempt = await shouldAttemptSyncNow();
      if (!okToAttempt) return { ran: false, message: "" };
    }

    // Lock to avoid multiple tabs syncing at the same time
    const locked = await acquireSyncLock();
    if (!locked) return { ran: false, message: "Sync already running" };

    try {
      await markSyncAttempt();

      const cfg = await getSyncConfig();
      if (!cfg) return { ran: true, message: "Sync not configured" };

      const dirtyRes = await storageGet([DIRTY_KEY]);
      const localDirty = !!dirtyRes[DIRTY_KEY];

      let remoteOk = false;
      let putOk = false;

      // Pull remote first
      let remote = null;
      try {
        remote = await remoteGet(cfg);
        remoteOk = true;
      } catch (e) {
        return { ran: true, message: `Sync failed: ${e?.message || e}` };
      }

      // Apply remote if newer
      let appliedRemote = false;
      if (remote) {
        appliedRemote = await applyRemoteIfNewer(remote);
      }

      // Push local only if local is dirty
      if (localDirty) {
        const payload = {
          updatedAt: Number(appState.updatedAt || 0),
          data: {
            todos: appState.todos || [],
            selected_group: appState.selected_group || "",
            user_name: appState.user_name || "",
          },
        };

        try {
          const res = await remotePut(cfg, payload);
          putOk = true;

          // If conflict, pull again and apply newer remote
          if (res?.conflict) {
            try {
              const remote2 = await remoteGet(cfg);
              remoteOk = true;
              const applied2 = await applyRemoteIfNewer(remote2);
              appliedRemote = appliedRemote || applied2;
            } catch {
              // ignore
            }
          }
        } catch (e) {
          return { ran: true, message: `Sync failed: ${e?.message || e}` };
        }
      }

      // Mark success if we reached server (GET ok is enough for once/day requirement)
      if (remoteOk || putOk) await markSyncSuccess();

      if (appliedRemote) rerenderFromState();

      return { ran: true, message: appliedRemote ? "Synced (updated)" : "Synced" };
    } finally {
      await releaseSyncLock();
    }
  }

  // Button click: force sync immediately
  forceSyncBtn.addEventListener("click", async () => {
    forceSyncBtn.disabled = true;
    setStatus("Syncing...");

    const res = await syncMaybe({ force: true });

    if (res?.message) {
      setStatus(res.message, { clearAfterMs: 2500 });
    } else {
      setStatus("Done", { clearAfterMs: 1500 });
    }

    forceSyncBtn.disabled = false;
  });

  // ---- TIME ----
  function updateTime() {
    timeElement.textContent = new Date().toLocaleTimeString();
  }
  setInterval(updateTime, 1000);
  updateTime();

  // -----------------------------
  // Your app logic (using appState)
  // -----------------------------
  async function getTodosFromStorage() {
    return appState.todos || [];
  }

  async function saveTodosToStorage(todos) {
    appState.todos = normalizeTodos(todos);
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
        todos.splice(indexInAll, 1);
        await saveTodosToStorage(todos);
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
        todos = normalizeTodos(seed);
        appState.todos = todos;
        await persistState({ markDirty: true });
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
    todos.push({ task: newTask, group, status: "pending" });
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
    await loadState();

    // Local render (instant)
    await initializeTodos();
    await setupUserNameInput();
    rerenderFromState();

    // Daily sync (at most once/day, even if you open new tab 100 times)
    const res = await syncMaybe({ force: false });
    if (res?.message) setStatus(res.message, { clearAfterMs: 1500 });
  })();
});
