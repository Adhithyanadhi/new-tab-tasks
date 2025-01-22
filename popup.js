document.addEventListener('DOMContentLoaded', function () {
  const captureButton = document.getElementById('captureButton');
  const firstName = document.getElementById('first-name-input');
  captureButton.addEventListener('click', captureScreenshot);
  function captureScreenshot() {
    firstName.value = "Adhithyan"
  }
});


document.getElementById("changeID").addEventListener("click", async() => {
  let [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
  });

  // Store sync value before the script is executed.
  let textBoxValue = document.getElementById('changeInput').value;
  chrome.storage.sync.set({
      textBoxValue
  });
  chrome.scripting.executeScript({
      target: {
          tabId: tab.id
      },
      function: setID,
  });
});





// The body of this function will be executed as a content script inside the
// current page
function setID() {
  chrome.storage.sync.get("textBoxValue", ({
      textBoxValue
  }) => {
      polls = document.querySelectorAll('[id ^= "POOL"]');
      Array.prototype.forEach.call(polls, callback);

      function callback() {
          for (var i = 0; i < polls.length; i++) {
              polls[i].value = textBoxValue;
          }
      }
  });
}