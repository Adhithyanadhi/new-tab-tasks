var div = document.createElement("div"); 
document.body.appendChild(div); 

// Set text content
div.innerText = "test123";

// Add styles to make it visible
div.style.position = "fixed"; // Fix position relative to the viewport
div.style.bottom = "20px";    // Position it 20px from the bottom
div.style.right = "20px";     // Position it 20px from the right
div.style.backgroundColor = "rgba(0, 0, 0, 0.8)"; // Black background with some transparency
div.style.color = "white";    // White text color
div.style.padding = "10px";   // Add some padding
div.style.borderRadius = "5px"; // Rounded corners
div.style.boxShadow = "0px 4px 6px rgba(0, 0, 0, 0.2)"; // Add a subtle shadow
div.style.zIndex = "1000";    // Ensure it's above other elements
