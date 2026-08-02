// Firebase config — safe to be public. Security is enforced by Firestore rules
// (each user can only read/write their own users/{uid} document), not by
// hiding this config. Fill these in from Firebase console → Project settings
// → General → Your apps → Web app → SDK setup and configuration.
export const firebaseConfig = {
  apiKey: 'AIzaSyCLreQ3Y0wcuRGQfTwqzxjxpLhyYkH8uIE',
  authDomain: 'gym-tracker-25f16.firebaseapp.com',
  projectId: 'gym-tracker-25f16',
  storageBucket: 'gym-tracker-25f16.firebasestorage.app',
  messagingSenderId: '742439898960',
  appId: '1:742439898960:web:6e2fbd2ffc77a3b4856655',
};

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from 'https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

// Firebase's email/password provider needs something shaped like an email, so
// usernames are mapped to a synthetic address under a domain nobody sends
// real mail to — never used for delivery, just as a unique identifier.
// Firebase's own "email already in use" uniqueness check does double duty as
// username-uniqueness enforcement here, so no extra Firestore bookkeeping
// is needed.
const USERNAME_DOMAIN = 'users.gymtracker.local';
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

function usernameToEmail(username) {
  return `${username.trim().toLowerCase()}@${USERNAME_DOMAIN}`;
}

export async function signUpWithUsername(username, password) {
  const clean = username.trim();
  if (!USERNAME_RE.test(clean)) {
    throw new Error('Username must be 3-20 characters: letters, numbers, underscores only.');
  }
  if (!password || password.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }
  try {
    const cred = await createUserWithEmailAndPassword(auth, usernameToEmail(clean), password);
    await updateProfile(cred.user, { displayName: clean });
    return cred.user;
  } catch (err) {
    if (err.code === 'auth/email-already-in-use') {
      throw new Error('That username is already taken.');
    }
    throw err;
  }
}

export async function signInWithUsername(username, password) {
  const clean = username.trim();
  if (!clean || !password) {
    throw new Error('Enter a username and password.');
  }
  try {
    const cred = await signInWithEmailAndPassword(auth, usernameToEmail(clean), password);
    return cred.user;
  } catch (err) {
    if (err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
      throw new Error('Incorrect username or password.');
    }
    throw err;
  }
}

export function signOut() {
  return firebaseSignOut(auth);
}

export function watchAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

export function userDocRef(uid) {
  return doc(db, 'users', uid);
}

export function fetchUserDoc(uid) {
  return getDoc(userDocRef(uid));
}

export function writeUserDoc(uid, data) {
  return setDoc(userDocRef(uid), data, { merge: true });
}

export function watchUserDoc(uid, callback) {
  return onSnapshot(userDocRef(uid), callback);
}
