// auth.js - Shared authentication for all pages
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { 
  getAuth, 
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { 
  getDatabase, 
  ref, 
  get 
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAM3XBYaYpUYld7LJsZpzJ9mZB50m5CUOw",
  authDomain: "aviator-82cdb.firebaseapp.com",
  projectId: "aviator-82cdb",
  databaseURL: "https://aviator-82cdb-default-rtdb.firebaseio.com"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);

// Enable persistence (keeps user logged in)
auth.setPersistence("local");

// Current user state
let currentUser = null;
let userData = null;

// Listen for auth state changes
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  
  if (user) {
    // Fetch user data from database
    const userRef = ref(database, 'users/' + user.uid);
    const snapshot = await get(userRef);
    if (snapshot.exists()) {
      userData = snapshot.val();
    }
    
    // Trigger any registered callbacks
    window.dispatchEvent(new CustomEvent('authChange', { 
      detail: { user: currentUser, userData: userData }
    }));
  } else {
    userData = null;
    window.dispatchEvent(new CustomEvent('authChange', { 
      detail: { user: null, userData: null }
    }));
  }
});

// Helper function to check if user is logged in
function requireAuth() {
  if (!currentUser) {
    window.location.href = "login.html";
    return false;
  }
  return true;
}

// Helper function to get current user
function getCurrentUser() {
  return currentUser;
}

// Helper function to get user data
function getUserData() {
  return userData;
}

// Logout function
async function logout() {
  await signOut(auth);
  window.location.href = "login.html";
}

// Export for use in other files
export { 
  auth, 
  database, 
  currentUser, 
  userData, 
  getCurrentUser, 
  getUserData,
  requireAuth, 
  logout,
  onAuthStateChanged
};