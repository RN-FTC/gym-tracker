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
