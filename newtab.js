document.addEventListener("DOMContentLoaded", () => {
  const timeElement = document.getElementById("time");
  const todoListElement = document.getElementById("todo-list");
  const newTodoInput = document.getElementById("new-todo-input");
  const addTodoButton = document.getElementById("add-todo-button");
  const nameInput = document.getElementById("name-input");
  const newGroupInput = document.getElementById("new-group-input");
  const groupTabs = document.getElementById("group-tabs");

  let selectedGroup = ""; // default to Ungrouped

  // ---- ⏰ TIME ----
  function updateTime() {
    const currentTime = new Date().toLocaleTimeString();
    timeElement.textContent = currentTime;
  }

  setInterval(updateTime, 1000);
  updateTime();

  // ---- 📝 TODOS ----
  async function getTodosFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get("todos", (result) => {
        resolve(result.todos || []);
      });
    });
  }

  async function saveTodosToStorage(todos) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ todos }, resolve);
    });
  }

  function renderTabsFromTodos(todos) {
    groupTabs.innerHTML = "";

    // Build unique set of groups, default group first
    const groupSet = new Set([""]);
    todos.forEach((t) => groupSet.add((t.group || "").trim()));

    const groups = Array.from(groupSet).sort((a, b) => {
      if (a && b) return a.localeCompare(b);
      if (a && !b) return 1; // ensure "" (Ungrouped) first
      if (!a && b) return -1;
      return 0;
    });

    groups.forEach((g) => {
      const btn = document.createElement("button");
      btn.className = "group-tab" + (g === selectedGroup ? " active" : "");
      btn.textContent = g || "Ungrouped";
      btn.addEventListener("click", async () => {
        selectedGroup = g;
        // keep group input in sync; if user adds without specifying group, use selectedGroup
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

    // Filter by selectedGroup
    const filtered = todos.filter((t) => ((t.group || "").trim() === (selectedGroup || "").trim()));

    // Maintain original tile rendering (no grouping titles when tabs are used)
    filtered.forEach((todo, indexInFiltered) => {
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
        todos = await response.json();
        saveTodosToStorage(todos);
      } catch (error) {
        console.error("Error fetching todos:", error);
        // Fall back to empty list but still render tabs
        todos = [];
      }
    }

    // Migration: ensure every todo has a `group` field
    const needsMigration = todos.some((t) => typeof t.group === "undefined");
    if (needsMigration) {
      todos = todos.map((t) => ({ ...t, group: (t.group || "").trim() }));
      await saveTodosToStorage(todos);
    }

    // Default selected group is Ungrouped
    selectedGroup = "";
    if (newGroupInput) newGroupInput.placeholder = "Group (optional)";

    renderTabsFromTodos(todos);
    displayTodos(todos);
  }

  async function addNewTodo() {
    const newTask = newTodoInput.value.trim();
    if (!newTask) {
      alert("Please enter a valid task!");
      return;
    }

    // Use typed group or fallback to selected tab
    const typedGroup = newGroupInput ? newGroupInput.value.trim() : "";
    const group = typedGroup || selectedGroup || "";

    const todos = await getTodosFromStorage();
    todos.push({ task: newTask, group, status: "pending" });
    await saveTodosToStorage(todos);

    // Switch to the task's group so the tab appears active
    selectedGroup = group;
    if (newGroupInput) newGroupInput.placeholder = group ? `Group: ${group}` : "Group (optional)";

    // Clear inputs; keep the selected tab
    newTodoInput.value = "";
    if (newGroupInput) newGroupInput.value = "";

    renderTabsFromTodos(todos);
    displayTodos(todos);
  }

  addTodoButton.addEventListener("click", addNewTodo);
  newTodoInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
      addNewTodo();
    }
  });
  if (newGroupInput) {
    newGroupInput.addEventListener("keypress", (event) => {
      if (event.key === "Enter") {
        addNewTodo();
      }
    });
  }

  // ---- 👤 USERNAME ----
  async function getUserNameFromStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get("user_name", (result) => {
        resolve(result.user_name || "");
      });
    });
  }

  async function saveUserNameToStorage(userName) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ user_name: userName }, resolve);
    });
  }

  async function setupUserNameInput() {
    const savedName = await getUserNameFromStorage();
    if (savedName) {
      nameInput.value = savedName;
    }

    async function save() {
      const typedName = nameInput.value.trim();
      await saveUserNameToStorage(typedName);
    }

    nameInput.addEventListener("blur", save);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        nameInput.blur(); // triggers blur handler and saves
      }
    });
  }

  // ---- 🚀 INIT ----
  initializeTodos();
  setupUserNameInput();
});

