// Firebase config — safe to be public. Security is enforced by Firestore rules
// (each user can only read/write their own users/{uid} document), not by
// hiding this config. Fill these in from Firebase console → Project settings
// → General → Your apps → Web app → SDK setup and configuration.
export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.appspot.com',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
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
