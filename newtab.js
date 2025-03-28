const timeElement = document.getElementById("time");
const todoListElement = document.getElementById("todo-list");
const newTodoInput = document.getElementById("new-todo-input");
const addTodoButton = document.getElementById("add-todo-button");

// Function to update the current time
function updateTime() {
  const currentTime = new Date().toLocaleTimeString();
  timeElement.textContent = `${currentTime}`;
}

newTodoInput.addEventListener("keypress", (event) => {
  if (event.key === "Enter") {
    addNewTodo();
  }
});

// Function to load todos from storage or initialize from JSON
async function initializeTodos() {
  const storedTodos = await getTodosFromStorage();

  if (storedTodos && storedTodos.length > 0) {
    displayTodos(storedTodos);
  } else {
    try {
      const response = await fetch("todo.json");
      const todos = await response.json();
      // saveTodosToStorage(todos);
      displayTodos(todos);
    } catch (error) {
      console.error("Error fetching todos:", error);
      todoListElement.textContent = "Failed to load tasks.";
    }
  }
}

// Function to get todos from Chrome storage
function getTodosFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get("todos", (result) => {
      resolve(result.todos || []);
    });
  });
}

// Function to save todos to Chrome storage
function saveTodosToStorage(todos) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ todos }, resolve);
  });
}

// Function to display todos with checkboxes
function displayTodos(todos) {
  const todoListElement = document.getElementById("todo-list");
  todoListElement.innerHTML = ""; // Clear existing todos

  todos.forEach((todo, index) => {
    const todoItem = document.createElement("div");
    todoItem.className = "todo-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.style.transform = "scale(1.5)";
    checkbox.checked = todo.status === "completed";
    checkbox.addEventListener("change", () =>
      updateTodoStatus(index, checkbox.checked)
    );

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
    deleteButton.addEventListener("click", () => {
      deleteTodo(index);
      displayTodos(todos.filter((_, i) => i !== index)); // Re-render list
    });

    todoItem.appendChild(checkbox);
    todoItem.appendChild(task);
    todoItem.appendChild(deleteButton);
    todoListElement.appendChild(todoItem);
  });
}


// Function to update a todo's status
async function updateTodoStatus(index, isCompleted) {
  const todos = await getTodosFromStorage();
  todos[index].status = isCompleted ? "completed" : "pending";
  await saveTodosToStorage(todos);
  displayTodos(todos);
}

async function deleteTodo(index) {
  const todos = await getTodosFromStorage();
  todos.splice(index, 1);
  await saveTodosToStorage(todos);
  displayTodos(todos);
}

// Function to add a new todo
// Function to add a new todo
async function addNewTodo() {
    const newTask = newTodoInput.value.trim();
    if (!newTask) {
      alert("Please enter a valid task!");
      return;
    }
  
    // Retrieve existing todos from storage
    const todos = await getTodosFromStorage();
  
    // Add the new todo to the list
    todos.push({ task: newTask, status: "pending" });
  
    // Save the updated list back to Chrome storage
    chrome.storage.local.set({ todos }, () => {
      // Confirm that the data has been saved successfully
      console.log("New todo saved:", todos);
  
      // Display the updated todo list
      displayTodos(todos);
    });
  
    // Clear the input field
    newTodoInput.value = "";
  }
  

// Initialize the page
updateTime();
setInterval(updateTime, 1000);
initializeTodos();

// Add event listener for the add button
addTodoButton.addEventListener("click", addNewTodo);
