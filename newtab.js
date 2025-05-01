document.addEventListener("DOMContentLoaded", () => {
  const timeElement = document.getElementById("time");
  const todoListElement = document.getElementById("todo-list");
  const newTodoInput = document.getElementById("new-todo-input");
  const addTodoButton = document.getElementById("add-todo-button");
  const nameInput = document.getElementById("name-input");

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

  function displayTodos(todos) {
    todoListElement.innerHTML = "";

    todos.forEach((todo, index) => {
      const todoItem = document.createElement("div");
      todoItem.className = "todo-item";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.style.transform = "scale(1.5)";
      checkbox.checked = todo.status === "completed";
      checkbox.addEventListener("change", async () => {
        todos[index].status = checkbox.checked ? "completed" : "pending";
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
        todos.splice(index, 1);
        await saveTodosToStorage(todos);
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
        todoListElement.textContent = "Failed to load tasks.";
        return;
      }
    }

    displayTodos(todos);
  }

  async function addNewTodo() {
    const newTask = newTodoInput.value.trim();
    if (!newTask) {
      alert("Please enter a valid task!");
      return;
    }

    const todos = await getTodosFromStorage();
    todos.push({ task: newTask, status: "pending" });
    await saveTodosToStorage(todos);
    displayTodos(todos);
    newTodoInput.value = "";
  }

  addTodoButton.addEventListener("click", addNewTodo);
  newTodoInput.addEventListener("keypress", (event) => {
    if (event.key === "Enter") {
      addNewTodo();
    }
  });

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
