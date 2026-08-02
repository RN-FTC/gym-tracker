import {
  signInWithGoogle,
  signOut,
  watchAuthState,
  fetchUserDoc,
  writeUserDoc,
  watchUserDoc,
  signUpWithUsername,
  signInWithUsername,
} from './firebase-init.js';
import { AI_ESTIMATE_ENDPOINT } from './ai-config.js';

(() => {
  'use strict';

  /* ---------------------------------------------------------------------
     Storage keys & helpers — localStorage is a write-through cache;
     Firestore (see AUTH & CLOUD SYNC below) is the source of truth once signed in.
  --------------------------------------------------------------------- */
  const LS_ROUTINES = 'gymtracker_routines';
  const LS_HISTORY = 'gymtracker_history';
  const LS_ACTIVE = 'gymtracker_active_workout';
  const LS_CARDIO = 'gymtracker_cardio';
  const LS_PROFILE = 'gymtracker_profile';
  const LS_FOOD = 'gymtracker_food';
  const LS_THEME = 'gymtracker_theme';

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error('Failed to load', key, e);
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  let routines = load(LS_ROUTINES, []);
  let history = load(LS_HISTORY, []);
  let activeWorkout = load(LS_ACTIVE, null); // { routineId, routineName, startedAt, exercises: [{name, sets: [{weight, reps}]}] }
  let cardioLog = load(LS_CARDIO, []); // [{ id, date, machine, incline, speed, durationMinutes }]
  let preferredName = load(LS_PROFILE, {}).preferredName || null;
  let bodyStats = load(LS_PROFILE, {}).bodyStats || null; // { weightLb, heightFt, heightIn, age, sex, activityLevel }
  let foodLog = load(LS_FOOD, []); // [{ id, date, description, calories, proteinG, carbG, fatG }]

  function persistLocal() {
    save(LS_ROUTINES, routines);
    save(LS_HISTORY, history);
    save(LS_ACTIVE, activeWorkout);
    save(LS_CARDIO, cardioLog);
    save(LS_PROFILE, { preferredName, bodyStats });
    save(LS_FOOD, foodLog);
  }

  const saveRoutines = () => { persistLocal(); schedulePush(); };
  const saveHistory = () => { persistLocal(); schedulePush(); };
  const saveActive = () => { persistLocal(); schedulePush(); };
  const saveCardio = () => { persistLocal(); schedulePush(); };
  const saveFood = () => { persistLocal(); schedulePush(); };
  const clearActive = () => { activeWorkout = null; persistLocal(); schedulePush(); };

  /* ---------------------------------------------------------------------
     THEME — light/dark/system. Local-device preference only (not synced to
     Firestore), applied before auth resolves so even the sign-in gate is
     themed correctly. The loading splash covers the brief moment this takes.
  --------------------------------------------------------------------- */
  const themeToggleEl = document.getElementById('theme-toggle');
  const themeColorMeta = document.querySelector('meta[name="theme-color"]');
  let currentThemeChoice = load(LS_THEME, 'system');

  function updateThemeColorMeta() {
    if (!themeColorMeta) return;
    requestAnimationFrame(() => {
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (bg) themeColorMeta.setAttribute('content', bg);
    });
  }

  function applyTheme(choice) {
    currentThemeChoice = choice;
    if (choice === 'light' || choice === 'dark') {
      document.documentElement.setAttribute('data-theme', choice);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    if (themeToggleEl) {
      themeToggleEl.querySelectorAll('.theme-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.themeChoice === choice);
      });
    }
    updateThemeColorMeta();
  }

  if (themeToggleEl) {
    themeToggleEl.addEventListener('click', e => {
      const chip = e.target.closest('.theme-chip');
      if (!chip) return;
      const choice = chip.dataset.themeChoice;
      save(LS_THEME, choice);
      applyTheme(choice);
    });
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (currentThemeChoice === 'system') updateThemeColorMeta();
    });
  }

  applyTheme(currentThemeChoice);

  /* ---------------------------------------------------------------------
     MORE SETTINGS — units, rest timer defaults/sound, data export.
     All device-local (not synced to Firestore) except units conversion,
     which only affects how bodyStats is entered/displayed.
  --------------------------------------------------------------------- */
  const LS_UNITS = 'gymtracker_units';
  const LS_DEFAULT_REST = 'gymtracker_default_rest';
  const LS_TIMER_SOUND = 'gymtracker_timer_sound';
  const LS_TIMER_VOLUME = 'gymtracker_timer_volume';
  const LS_TIMER_VIBRATE = 'gymtracker_timer_vibrate';

  const KG_PER_LB = 0.453592;
  const CM_PER_IN = 2.54;
  const lbToKg = lb => lb * KG_PER_LB;
  const kgToLb = kg => kg / KG_PER_LB;
  const cmToInches = cm => cm / CM_PER_IN;
  const inchesToCm = inches => inches * CM_PER_IN;

  let unitsSystem = load(LS_UNITS, 'imperial');
  let defaultRestSeconds = load(LS_DEFAULT_REST, 90);
  let timerSoundEnabled = load(LS_TIMER_SOUND, true);
  let timerVolume = load(LS_TIMER_VOLUME, 70);
  let timerVibrateEnabled = load(LS_TIMER_VIBRATE, true);

  const unitsToggleEl = document.getElementById('units-toggle');
  const weightUnitLabel = document.getElementById('weight-unit-label');
  const heightImperialRow = document.getElementById('height-imperial-row');
  const defaultRestInput = document.getElementById('default-rest-input');
  const timerSoundToggle = document.getElementById('timer-sound-toggle');
  const timerVolumeInput = document.getElementById('timer-volume-input');
  const timerVolumeValue = document.getElementById('timer-volume-value');
  const timerVibrateToggle = document.getElementById('timer-vibrate-toggle');
  const exportDataBtn = document.getElementById('export-data-btn');

  function applyUnitsUi(system) {
    unitsSystem = system;
    unitsToggleEl.querySelectorAll('.units-chip').forEach(chip => {
      chip.classList.toggle('active', chip.dataset.units === system);
    });
    if (system === 'metric') {
      weightUnitLabel.textContent = '(kg)';
      heightImperialRow.classList.add('hidden');
      heightCmInput.classList.remove('hidden');
    } else {
      weightUnitLabel.textContent = '(lbs)';
      heightImperialRow.classList.remove('hidden');
      heightCmInput.classList.add('hidden');
    }
  }

  unitsToggleEl.addEventListener('click', e => {
    const chip = e.target.closest('.units-chip');
    if (!chip) return;
    save(LS_UNITS, chip.dataset.units);
    applyUnitsUi(chip.dataset.units);
    if (bodyStats) populateWeightForm(bodyStats); // re-render existing numbers in the newly chosen units
  });

  defaultRestInput.value = defaultRestSeconds;
  defaultRestInput.addEventListener('change', () => {
    const secs = Math.max(5, parseInt(defaultRestInput.value, 10) || 90);
    defaultRestSeconds = secs;
    defaultRestInput.value = secs;
    save(LS_DEFAULT_REST, secs);
    if (!timerRunning) {
      timerTotalSeconds = secs;
      timerRemaining = secs;
      timerSecondsInput.value = secs;
      renderTimer();
    }
  });

  function setTimerSoundToggle(enabled) {
    timerSoundEnabled = enabled;
    timerSoundToggle.classList.toggle('active', enabled);
    timerSoundToggle.setAttribute('aria-checked', String(enabled));
  }
  setTimerSoundToggle(timerSoundEnabled);
  timerSoundToggle.addEventListener('click', () => {
    const next = !timerSoundEnabled;
    save(LS_TIMER_SOUND, next);
    setTimerSoundToggle(next);
  });

  timerVolumeInput.value = timerVolume;
  timerVolumeValue.textContent = timerVolume + '%';
  timerVolumeInput.addEventListener('input', () => {
    timerVolume = Number(timerVolumeInput.value);
    timerVolumeValue.textContent = timerVolume + '%';
    save(LS_TIMER_VOLUME, timerVolume);
  });

  function setTimerVibrateToggle(enabled) {
    timerVibrateEnabled = enabled;
    timerVibrateToggle.classList.toggle('active', enabled);
    timerVibrateToggle.setAttribute('aria-checked', String(enabled));
  }
  setTimerVibrateToggle(timerVibrateEnabled);
  timerVibrateToggle.addEventListener('click', () => {
    const next = !timerVibrateEnabled;
    save(LS_TIMER_VIBRATE, next);
    setTimerVibrateToggle(next);
  });

  exportDataBtn.addEventListener('click', () => {
    const exportPayload = {
      exportedAt: new Date().toISOString(),
      preferredName,
      bodyStats,
      routines,
      history,
      cardioLog,
      foodLog,
    };
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gym-tracker-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });

  /* ---------------------------------------------------------------------
     AUTH & CLOUD SYNC
  --------------------------------------------------------------------- */
  const signinGate = document.getElementById('signin-gate');
  const appShell = document.getElementById('app-shell');
  const googleSigninBtn = document.getElementById('google-signin-btn');
  const signinErrorEl = document.getElementById('signin-error');
  const accountAvatar = document.getElementById('account-avatar');
  const signOutBtn = document.getElementById('sign-out-btn');
  const importModal = document.getElementById('import-modal');
  const importSkipBtn = document.getElementById('import-skip-btn');
  const importConfirmBtn = document.getElementById('import-confirm-btn');
  const loadingScreen = document.getElementById('loading-screen');
  const nameModal = document.getElementById('name-modal');
  const nameInput = document.getElementById('name-input');
  const nameConfirmBtn = document.getElementById('name-confirm-btn');
  const welcomeScreen = document.getElementById('welcome-screen');
  const welcomeGreetingEl = document.getElementById('welcome-greeting');
  const welcomeStatEl = document.getElementById('welcome-stat');
  const welcomeContinueBtn = document.getElementById('welcome-continue-btn');
  const settingsAccountAvatar = document.getElementById('settings-account-avatar');
  const settingsAccountName = document.getElementById('settings-account-name');
  const settingsAccountEmail = document.getElementById('settings-account-email');
  const settingsSignoutBtn = document.getElementById('settings-signout-btn');
  const settingsAccountSignedIn = document.getElementById('settings-account-signed-in');
  const settingsAccountGuest = document.getElementById('settings-account-guest');
  const settingsSigninBtn = document.getElementById('settings-signin-btn');
  const signinUsernameInput = document.getElementById('signin-username-input');
  const signinPasswordInput = document.getElementById('signin-password-input');
  const signinLoginBtn = document.getElementById('signin-login-btn');
  const signinSignupBtn = document.getElementById('signin-signup-btn');
  const guestModeBtn = document.getElementById('guest-mode-btn');

  const LS_GUEST = 'gymtracker_guest_mode';
  let isGuestMode = load(LS_GUEST, false);

  let currentUser = null;
  let unsubscribeUserDoc = null;
  let remoteVersion = 0;
  let pushTimer = null;

  // Which screen (sign-in gate vs app) should be revealed once the loading
  // splash is done. Kept separate from the reveal itself so the splash never
  // crossfades with mismatched content underneath — see maybeHideLoadingScreen().
  let pendingView = null; // 'signin' | 'app'

  function isLoadingScreenGone() {
    return !loadingScreen || loadingScreen.classList.contains('hide');
  }

  function revealPendingView() {
    if (pendingView === 'signin') {
      signinGate.classList.remove('hidden');
      appShell.classList.add('hidden');
    } else if (pendingView === 'app') {
      appShell.classList.remove('hidden');
      signinGate.classList.add('hidden');
    }
  }

  function showSigninGate() {
    pendingView = 'signin';
    if (isLoadingScreenGone()) revealPendingView();
  }

  function showAppShell() {
    pendingView = 'app';
    if (isLoadingScreenGone()) revealPendingView();
  }

  function pushNow() {
    if (!currentUser) return Promise.resolve();
    remoteVersion += 1;
    return writeUserDoc(currentUser.uid, {
      routines,
      history,
      activeWorkout,
      cardioLog,
      preferredName,
      bodyStats,
      foodLog,
      version: remoteVersion,
      updatedAt: Date.now(),
    }).catch(err => console.error('Cloud sync failed', err));
  }

  function schedulePush() {
    if (!currentUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 500);
  }

  // Applies a remote Firestore doc to local state, unless it's just an echo of
  // our own last push (same version we just wrote) — avoids re-rendering (and
  // stealing focus from active inputs) on every round-trip of our own writes.
  function applyRemoteData(data) {
    if (!data) return;
    if (typeof data.version === 'number' && data.version === remoteVersion) return;
    if (typeof data.version === 'number') remoteVersion = data.version;
    routines = data.routines || [];
    history = data.history || [];
    activeWorkout = data.activeWorkout || null;
    cardioLog = data.cardioLog || [];
    if (data.preferredName) preferredName = data.preferredName;
    if (data.bodyStats) bodyStats = data.bodyStats;
    foodLog = data.foodLog || [];
    persistLocal();
    renderRoutineSelect();
    renderRoutinesList();
    renderHistoryList();
    renderActiveWorkout();
    renderHome();
    renderBmiTab();
  }

  function showImportModal() { importModal.classList.remove('hidden'); }
  function closeImportModal() { importModal.classList.add('hidden'); }

  // Import/skip resolve whichever promise promptImport() is currently waiting on.
  let importResolve = null;

  function promptImport() {
    return new Promise(resolve => {
      importResolve = resolve;
      showImportModal();
    });
  }

  importConfirmBtn.addEventListener('click', () => {
    closeImportModal();
    pushNow();
    if (importResolve) { importResolve(); importResolve = null; }
  });

  importSkipBtn.addEventListener('click', () => {
    routines = [];
    history = [];
    activeWorkout = null;
    cardioLog = [];
    foodLog = [];
    persistLocal();
    renderRoutineSelect();
    renderRoutinesList();
    renderHistoryList();
    renderActiveWorkout();
    renderHome();
    renderBmiTab();
    closeImportModal();
    if (importResolve) { importResolve(); importResolve = null; }
  });

  // Prompts for a display name on first sign-in, prefilled from the Google account.
  function promptForName(user) {
    return new Promise(resolve => {
      const guess = (user.displayName || '').split(' ')[0] || '';
      nameInput.value = guess;
      nameModal.classList.remove('hidden');
      setTimeout(() => nameInput.focus(), 50);

      const onSubmit = () => {
        preferredName = nameInput.value.trim() || guess || 'there';
        persistLocal();
        nameModal.classList.add('hidden');
        nameConfirmBtn.removeEventListener('click', onSubmit);
        nameInput.removeEventListener('keydown', onKeydown);
        resolve();
      };
      const onKeydown = e => { if (e.key === 'Enter') onSubmit(); };

      nameConfirmBtn.addEventListener('click', onSubmit);
      nameInput.addEventListener('keydown', onKeydown);
    });
  }

  function showWelcomeScreen() {
    const hour = new Date().getHours();
    const timeGreeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    welcomeGreetingEl.textContent = `${timeGreeting}, ${preferredName || 'there'}`;

    const totalSessions = history.length + cardioLog.length;
    welcomeStatEl.textContent = totalSessions > 0
      ? `${totalSessions} workout${totalSessions === 1 ? '' : 's'} logged so far — let's keep going.`
      : `Let's log your first workout.`;

    welcomeScreen.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => welcomeScreen.classList.add('show')));

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      welcomeScreen.classList.remove('show');
      setTimeout(() => welcomeScreen.classList.add('hidden'), 400);
      welcomeContinueBtn.removeEventListener('click', dismiss);
      clearTimeout(autoTimer);
    };
    const autoTimer = setTimeout(dismiss, 3200);
    welcomeContinueBtn.addEventListener('click', dismiss);
  }

  function renderAccountBadge(user) {
    if (user.photoURL) {
      accountAvatar.src = user.photoURL;
      accountAvatar.alt = user.displayName || user.email || 'Account';
      accountAvatar.classList.remove('hidden');
      settingsAccountAvatar.src = user.photoURL;
      settingsAccountAvatar.alt = user.displayName || user.email || 'Account';
      settingsAccountAvatar.classList.remove('hidden');
    } else {
      accountAvatar.classList.add('hidden');
      settingsAccountAvatar.classList.add('hidden');
    }
    settingsAccountName.textContent = user.displayName || 'Signed in';
    // Firebase email/password accounts use a synthetic @users.gymtracker.local
    // address under the hood (see firebase-init.js) — showing that would be
    // confusing, so just show the username there instead.
    settingsAccountEmail.textContent = (user.email || '').endsWith('@users.gymtracker.local')
      ? ''
      : (user.email || '');
  }

  // Toggles the Settings tab's Account card between "signed in" and "guest" layouts.
  function renderAccountSection() {
    if (currentUser) {
      settingsAccountSignedIn.classList.remove('hidden');
      settingsAccountGuest.classList.add('hidden');
    } else {
      settingsAccountSignedIn.classList.add('hidden');
      settingsAccountGuest.classList.remove('hidden');
    }
  }

  googleSigninBtn.addEventListener('click', () => {
    signinErrorEl.classList.add('hidden');
    googleSigninBtn.disabled = true;
    signInWithGoogle()
      .catch(err => {
        console.error('Sign-in failed', err);
        signinErrorEl.textContent = 'Sign-in failed: ' + (err.code || err.message || 'unknown error');
        signinErrorEl.classList.remove('hidden');
      })
      .finally(() => { googleSigninBtn.disabled = false; });
  });

  async function handleEmailAuthAction(action) {
    signinErrorEl.classList.add('hidden');
    const username = signinUsernameInput.value;
    const password = signinPasswordInput.value;
    signinLoginBtn.disabled = true;
    signinSignupBtn.disabled = true;
    try {
      if (action === 'signup') {
        await signUpWithUsername(username, password);
      } else {
        await signInWithUsername(username, password);
      }
      // watchAuthState below picks up the new session and runs handleSignedIn —
      // same onboarding flow (name prompt/import/welcome) as Google sign-in.
    } catch (err) {
      console.error('Email auth failed', err);
      signinErrorEl.textContent = err.message || 'Something went wrong.';
      signinErrorEl.classList.remove('hidden');
    } finally {
      signinLoginBtn.disabled = false;
      signinSignupBtn.disabled = false;
    }
  }
  signinLoginBtn.addEventListener('click', () => handleEmailAuthAction('login'));
  signinSignupBtn.addEventListener('click', () => handleEmailAuthAction('signup'));

  function exitGuestMode() {
    isGuestMode = false;
    save(LS_GUEST, false);
    showSigninGate();
  }

  guestModeBtn.addEventListener('click', () => {
    isGuestMode = true;
    save(LS_GUEST, true);
    handleGuestMode();
  });

  settingsSigninBtn.addEventListener('click', exitGuestMode);

  signOutBtn.addEventListener('click', () => {
    if (isGuestMode) {
      exitGuestMode();
    } else {
      signOut().catch(err => console.error('Sign-out failed', err));
    }
  });

  settingsSignoutBtn.addEventListener('click', () => {
    signOut().catch(err => console.error('Sign-out failed', err));
  });

  const LOADING_FADE_MS = 500; // must match #loading-screen's CSS transition duration

  let authResolved = false;
  let minSplashDelayDone = false;

  function maybeHideLoadingScreen() {
    if (authResolved && minSplashDelayDone && loadingScreen && !loadingScreen.classList.contains('hide')) {
      loadingScreen.classList.add('hide');
      // Wait for the splash to fully fade before revealing what's underneath,
      // so the two full-screen panels never crossfade into a garbled overlap.
      setTimeout(revealPendingView, LOADING_FADE_MS);
    }
  }
  setTimeout(() => { minSplashDelayDone = true; maybeHideLoadingScreen(); }, 900);

  async function handleSignedIn(user) {
    currentUser = user;
    renderAccountBadge(user);
    renderAccountSection();
    showAppShell();

    let isNewAccount = false;
    try {
      const snap = await fetchUserDoc(user.uid);
      if (snap.exists()) {
        applyRemoteData(snap.data());
      } else {
        isNewAccount = true;
        remoteVersion = 0;
      }
    } catch (err) {
      console.error('Failed to fetch cloud data', err);
    }

    if (unsubscribeUserDoc) unsubscribeUserDoc();
    unsubscribeUserDoc = watchUserDoc(user.uid, snap => {
      if (snap.exists()) applyRemoteData(snap.data());
    });

    authResolved = true;
    maybeHideLoadingScreen();

    // Onboarding, in order: pick a name (first time only) -> offer to import
    // any existing local data into the new account -> greet with a welcome screen.
    if (!preferredName) {
      await promptForName(user);
    }
    if (isNewAccount) {
      const hasLocalData = routines.length > 0 || history.length > 0 || cardioLog.length > 0 || foodLog.length > 0 || activeWorkout;
      if (hasLocalData) {
        await promptImport();
      } else {
        pushNow();
      }
    }
    showWelcomeScreen();
  }

  function handleSignedOut() {
    currentUser = null;
    if (unsubscribeUserDoc) { unsubscribeUserDoc(); unsubscribeUserDoc = null; }
    showSigninGate();
    authResolved = true;
    maybeHideLoadingScreen();
  }

  // Guest mode: fully local, no Firestore involved at all — mirrors
  // handleSignedIn's onboarding (name prompt + welcome screen) but skips the
  // account fetch/sync/import steps entirely, since there's no cloud account.
  async function handleGuestMode() {
    currentUser = null;
    if (unsubscribeUserDoc) { unsubscribeUserDoc(); unsubscribeUserDoc = null; }
    renderAccountSection();
    showAppShell();
    authResolved = true;
    maybeHideLoadingScreen();

    if (!preferredName) {
      await promptForName({ displayName: '' });
    }
    showWelcomeScreen();
  }

  watchAuthState(user => {
    if (user) {
      isGuestMode = false;
      save(LS_GUEST, false);
      handleSignedIn(user);
    } else if (isGuestMode) {
      handleGuestMode();
    } else {
      handleSignedOut();
    }
  });

  /* ---------------------------------------------------------------------
     Tabs
  --------------------------------------------------------------------- */
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  function switchTab(name) {
    tabButtons.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    tabPanels.forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  }

  tabButtons.forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  /* ---------------------------------------------------------------------
     HOME TAB — dashboard: greeting, quick stats, quick actions, recent activity
  --------------------------------------------------------------------- */
  const homeGreetingEl = document.getElementById('home-greeting');
  const homeDateEl = document.getElementById('home-date');
  const homeStrengthCountEl = document.getElementById('home-strength-count');
  const homeCardioCountEl = document.getElementById('home-cardio-count');
  const homeWeekCountEl = document.getElementById('home-week-count');
  const homeStartWorkoutBtn = document.getElementById('home-start-workout-btn');
  const homeLogCardioBtn = document.getElementById('home-log-cardio-btn');
  const homeViewHistoryBtn = document.getElementById('home-view-history-btn');
  const homeRecentListEl = document.getElementById('home-recent-list');
  const homeRecentEmptyMsg = document.getElementById('home-recent-empty');

  homeStartWorkoutBtn.addEventListener('click', () => switchTab('workout'));
  homeLogCardioBtn.addEventListener('click', () => switchTab('cardio'));
  homeViewHistoryBtn.addEventListener('click', () => switchTab('history'));

  function renderHome() {
    const hour = new Date().getHours();
    const timeGreeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    homeGreetingEl.textContent = preferredName ? `${timeGreeting}, ${preferredName}` : timeGreeting;
    homeDateEl.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    const combined = getCombinedEntries();
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeekCount = combined.filter(e => new Date(e.date).getTime() >= weekAgo).length;

    homeStrengthCountEl.textContent = history.length;
    homeCardioCountEl.textContent = cardioLog.length;
    homeWeekCountEl.textContent = thisWeekCount;

    homeRecentListEl.innerHTML = '';
    const recent = combined.slice(0, 3);
    homeRecentEmptyMsg.classList.toggle('hidden', recent.length > 0);

    recent.forEach(entry => {
      const isCardio = entry.type === 'cardio';
      const row = document.createElement('div');
      row.className = 'home-recent-item';

      const left = document.createElement('div');
      const titleDiv = document.createElement('div');
      titleDiv.className = 'home-recent-title';
      titleDiv.textContent = isCardio ? entry.machine : entry.routineName;
      left.appendChild(titleDiv);

      const dateDiv = document.createElement('div');
      dateDiv.className = 'muted home-recent-date';
      dateDiv.textContent = formatDate(entry.date);
      left.appendChild(dateDiv);

      row.appendChild(left);

      const tag = document.createElement('span');
      tag.className = isCardio ? 'routine-tag cardio-tag' : 'routine-tag';
      tag.textContent = isCardio ? 'Cardio' : 'Strength';
      row.appendChild(tag);

      homeRecentListEl.appendChild(row);
    });
  }

  /* ---------------------------------------------------------------------
     WORKOUT TAB
  --------------------------------------------------------------------- */
  const routineSelect = document.getElementById('routine-select');
  const startWorkoutBtn = document.getElementById('start-workout-btn');
  const noRoutinesMsg = document.getElementById('no-routines-msg');
  const workoutPicker = document.getElementById('workout-picker');
  const activeWorkoutEl = document.getElementById('active-workout');
  const activeRoutineNameEl = document.getElementById('active-routine-name');
  const activeDateEl = document.getElementById('active-date');
  const exerciseListEl = document.getElementById('exercise-list');
  const newExerciseInput = document.getElementById('new-exercise-input');
  const addExerciseBtn = document.getElementById('add-exercise-btn');
  const finishWorkoutBtn = document.getElementById('finish-workout-btn');
  const cancelWorkoutBtn = document.getElementById('cancel-workout-btn');

  function renderRoutineSelect() {
    routineSelect.innerHTML = '<option value="">Select a routine…</option>';
    routines.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = r.name;
      routineSelect.appendChild(opt);
    });
    noRoutinesMsg.classList.toggle('hidden', routines.length > 0);
  }

  function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) +
      ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function startWorkout(routineId) {
    const routine = routines.find(r => r.id === routineId);
    if (!routine) return;
    activeWorkout = {
      routineId: routine.id,
      routineName: routine.name,
      startedAt: new Date().toISOString(),
      exercises: routine.exercises.map(ex => ({ name: ex.name, sets: [] })),
    };
    saveActive();
    renderActiveWorkout();
  }

  startWorkoutBtn.addEventListener('click', () => {
    if (!routineSelect.value) return;
    startWorkout(routineSelect.value);
  });

  function renderActiveWorkout() {
    if (!activeWorkout) {
      workoutPicker.classList.remove('hidden');
      activeWorkoutEl.classList.add('hidden');
      return;
    }
    workoutPicker.classList.add('hidden');
    activeWorkoutEl.classList.remove('hidden');
    activeRoutineNameEl.textContent = activeWorkout.routineName;
    activeDateEl.textContent = formatDate(activeWorkout.startedAt);

    exerciseListEl.innerHTML = '';
    activeWorkout.exercises.forEach((ex, exIdx) => {
      const block = document.createElement('div');
      block.className = 'exercise-block';

      const header = document.createElement('div');
      header.className = 'exercise-header';
      const h3 = document.createElement('h3');
      h3.textContent = ex.name;
      header.appendChild(h3);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn icon-btn';
      removeBtn.title = 'Remove exercise';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        activeWorkout.exercises.splice(exIdx, 1);
        saveActive();
        renderActiveWorkout();
      });
      header.appendChild(removeBtn);
      block.appendChild(header);

      const table = document.createElement('table');
      table.className = 'sets-table';
      table.innerHTML = '<thead><tr><th></th><th>Weight</th><th>Reps</th><th></th></tr></thead>';
      const tbody = document.createElement('tbody');

      ex.sets.forEach((set, setIdx) => {
        const tr = document.createElement('tr');

        const numTd = document.createElement('td');
        numTd.className = 'set-num';
        numTd.textContent = setIdx + 1;
        tr.appendChild(numTd);

        const weightTd = document.createElement('td');
        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.min = '0';
        weightInput.step = 'any';
        weightInput.placeholder = '0';
        weightInput.value = set.weight ?? '';
        weightInput.addEventListener('input', () => {
          set.weight = weightInput.value;
          saveActive();
        });
        weightTd.appendChild(weightInput);
        tr.appendChild(weightTd);

        const repsTd = document.createElement('td');
        const repsInput = document.createElement('input');
        repsInput.type = 'number';
        repsInput.min = '0';
        repsInput.step = '1';
        repsInput.placeholder = '0';
        repsInput.value = set.reps ?? '';
        repsInput.addEventListener('input', () => {
          set.reps = repsInput.value;
          saveActive();
        });
        repsTd.appendChild(repsInput);
        tr.appendChild(repsTd);

        const delTd = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.className = 'btn icon-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete set';
        delBtn.addEventListener('click', () => {
          ex.sets.splice(setIdx, 1);
          saveActive();
          renderActiveWorkout();
        });
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      block.appendChild(table);

      const addSetBtn = document.createElement('button');
      addSetBtn.className = 'add-set-btn';
      addSetBtn.textContent = '+ Add set';
      addSetBtn.addEventListener('click', () => {
        const last = ex.sets[ex.sets.length - 1];
        ex.sets.push({ weight: last ? last.weight : '', reps: last ? last.reps : '' });
        saveActive();
        renderActiveWorkout();
      });
      block.appendChild(addSetBtn);

      exerciseListEl.appendChild(block);
    });
  }

  addExerciseBtn.addEventListener('click', () => {
    const name = newExerciseInput.value.trim();
    if (!name || !activeWorkout) return;
    activeWorkout.exercises.push({ name, sets: [] });
    newExerciseInput.value = '';
    saveActive();
    renderActiveWorkout();
  });

  newExerciseInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') addExerciseBtn.click();
  });

  finishWorkoutBtn.addEventListener('click', () => {
    if (!activeWorkout) return;
    const cleaned = activeWorkout.exercises
      .map(ex => ({
        name: ex.name,
        sets: ex.sets
          .filter(s => (s.weight !== '' && s.weight != null) || (s.reps !== '' && s.reps != null))
          .map(s => ({ weight: s.weight || '0', reps: s.reps || '0' })),
      }))
      .filter(ex => ex.sets.length > 0);

    if (cleaned.length === 0) {
      if (!confirm('No sets were logged. Discard this workout?')) return;
      clearActive();
      renderActiveWorkout();
      return;
    }

    history.unshift({
      id: uid(),
      date: activeWorkout.startedAt,
      routineId: activeWorkout.routineId,
      routineName: activeWorkout.routineName,
      exercises: cleaned,
    });
    saveHistory();
    clearActive();
    renderActiveWorkout();
    renderHistoryList();
    renderHome();
    switchTab('history');
  });

  cancelWorkoutBtn.addEventListener('click', () => {
    if (!confirm('Cancel this workout? Unsaved logging will be lost.')) return;
    clearActive();
    renderActiveWorkout();
  });

  /* ---------------------------------------------------------------------
     ROUTINES TAB
  --------------------------------------------------------------------- */
  const routinesListEl = document.getElementById('routines-list');
  const newRoutineBtn = document.getElementById('new-routine-btn');

  const routineModal = document.getElementById('routine-modal');
  const routineModalTitle = document.getElementById('routine-modal-title');
  const routineNameInput = document.getElementById('routine-name-input');
  const routineExerciseInputsEl = document.getElementById('routine-exercise-inputs');
  const routineAddExerciseBtn = document.getElementById('routine-add-exercise-btn');
  const routineCancelBtn = document.getElementById('routine-cancel-btn');
  const routineSaveBtn = document.getElementById('routine-save-btn');

  let editingRoutineId = null;

  function renderRoutinesList() {
    routinesListEl.innerHTML = '';
    if (routines.length === 0) {
      routinesListEl.innerHTML = '<p class="muted">No routines yet. Create your first one above.</p>';
      return;
    }
    routines.forEach(r => {
      const item = document.createElement('div');
      item.className = 'routine-item';

      const left = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'routine-item-name';
      name.textContent = r.name;
      left.appendChild(name);

      const preview = document.createElement('div');
      preview.className = 'routine-tag-preview';
      preview.textContent = r.exercises.length
        ? r.exercises.map(e => e.name).join(', ')
        : 'No exercises';
      left.appendChild(preview);

      item.appendChild(left);

      const actions = document.createElement('div');
      actions.className = 'routine-item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'btn icon-btn';
      editBtn.textContent = '✎';
      editBtn.title = 'Edit routine';
      editBtn.addEventListener('click', () => openRoutineModal(r.id));
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn icon-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete routine';
      delBtn.addEventListener('click', () => {
        if (!confirm(`Delete routine "${r.name}"? This won't affect past history.`)) return;
        routines = routines.filter(x => x.id !== r.id);
        saveRoutines();
        renderRoutinesList();
        renderRoutineSelect();
      });
      actions.appendChild(delBtn);

      item.appendChild(actions);
      routinesListEl.appendChild(item);
    });
  }

  function addRoutineExerciseRow(value = '') {
    const row = document.createElement('div');
    row.className = 'routine-exercise-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Exercise name';
    input.value = value;
    row.appendChild(input);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn icon-btn';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => row.remove());
    row.appendChild(removeBtn);

    routineExerciseInputsEl.appendChild(row);
    return input;
  }

  function openRoutineModal(routineId = null) {
    editingRoutineId = routineId;
    routineExerciseInputsEl.innerHTML = '';

    if (routineId) {
      const r = routines.find(x => x.id === routineId);
      routineModalTitle.textContent = 'Edit Routine';
      routineNameInput.value = r.name;
      if (r.exercises.length) {
        r.exercises.forEach(ex => addRoutineExerciseRow(ex.name));
      } else {
        addRoutineExerciseRow();
      }
    } else {
      routineModalTitle.textContent = 'New Routine';
      routineNameInput.value = '';
      addRoutineExerciseRow();
      addRoutineExerciseRow();
      addRoutineExerciseRow();
    }

    routineModal.classList.remove('hidden');
    routineNameInput.focus();
  }

  function closeRoutineModal() {
    routineModal.classList.add('hidden');
    editingRoutineId = null;
  }

  newRoutineBtn.addEventListener('click', () => openRoutineModal());
  routineAddExerciseBtn.addEventListener('click', () => addRoutineExerciseRow());
  routineCancelBtn.addEventListener('click', closeRoutineModal);
  routineModal.addEventListener('click', e => { if (e.target === routineModal) closeRoutineModal(); });

  routineSaveBtn.addEventListener('click', () => {
    const name = routineNameInput.value.trim();
    if (!name) {
      alert('Please give this routine a name.');
      routineNameInput.focus();
      return;
    }
    const exerciseNames = Array.from(routineExerciseInputsEl.querySelectorAll('input'))
      .map(i => i.value.trim())
      .filter(Boolean);

    if (editingRoutineId) {
      const r = routines.find(x => x.id === editingRoutineId);
      r.name = name;
      r.exercises = exerciseNames.map(n => {
        const existing = r.exercises.find(e => e.name === n);
        return existing || { id: uid(), name: n };
      });
    } else {
      routines.push({
        id: uid(),
        name,
        exercises: exerciseNames.map(n => ({ id: uid(), name: n })),
      });
    }

    saveRoutines();
    renderRoutinesList();
    renderRoutineSelect();
    closeRoutineModal();
  });

  /* ---------------------------------------------------------------------
     CARDIO TAB — logging only; past sessions live in the History tab
  --------------------------------------------------------------------- */
  const cardioMachineInput = document.getElementById('cardio-machine-input');
  const cardioInclineInput = document.getElementById('cardio-incline-input');
  const cardioSpeedInput = document.getElementById('cardio-speed-input');
  const cardioDurationInput = document.getElementById('cardio-duration-input');
  const cardioLogBtn = document.getElementById('cardio-log-btn');

  cardioLogBtn.addEventListener('click', () => {
    const machine = cardioMachineInput.value.trim();
    const duration = parseFloat(cardioDurationInput.value);
    if (!machine) {
      alert('Enter a machine or activity (e.g. Treadmill).');
      cardioMachineInput.focus();
      return;
    }
    if (!duration || duration <= 0) {
      alert('Enter how long you did it for (minutes).');
      cardioDurationInput.focus();
      return;
    }
    const incline = cardioInclineInput.value.trim();
    const speed = cardioSpeedInput.value.trim();

    cardioLog.unshift({
      id: uid(),
      date: new Date().toISOString(),
      machine,
      incline: incline || null,
      speed: speed || null,
      durationMinutes: duration,
    });

    saveCardio();
    cardioMachineInput.value = '';
    cardioInclineInput.value = '';
    cardioSpeedInput.value = '';
    cardioDurationInput.value = '';
    renderHistoryList();
    renderHome();
    cardioMachineInput.focus();
  });

  /* ---------------------------------------------------------------------
     BMI TAB — stats form + BMI. General-purpose estimates (Mifflin-St Jeor
     for BMR, standard adult BMI bands) — not medical advice. The messaging
     is body-positive throughout, but stays graduated and realistic: a mild
     deviation gets a gentle nudge, a genuinely dangerous BMI (very
     underweight or very overweight) says so plainly and points to a doctor,
     rather than undersizing a real health risk with soft language.
  --------------------------------------------------------------------- */
  const weightInput = document.getElementById('weight-input');
  const heightFtInput = document.getElementById('height-ft-input');
  const heightInInput = document.getElementById('height-in-input');
  const heightCmInput = document.getElementById('height-cm-input');
  const ageInput = document.getElementById('age-input');
  const sexToggleEl = document.getElementById('sex-toggle');
  const activitySelect = document.getElementById('activity-select');
  const weightCalcBtn = document.getElementById('weight-calc-btn');
  const weightResultsEl = document.getElementById('weight-results');
  const weightBmiValueEl = document.getElementById('weight-bmi-value');
  const weightBmiTagEl = document.getElementById('weight-bmi-tag');
  const weightBmiNoteEl = document.getElementById('weight-bmi-note');
  const weightExtremeNoteEl = document.getElementById('weight-extreme-note');
  const weightCaloriesValueEl = document.getElementById('weight-calories-value');
  const weightProteinValueEl = document.getElementById('weight-protein-value');
  const weightCarbsValueEl = document.getElementById('weight-carbs-value');
  const weightFatValueEl = document.getElementById('weight-fat-value');
  const bmiViewFoodBtn = document.getElementById('bmi-view-food-btn');
  const foodGoBmiBtn = document.getElementById('food-go-bmi-btn');
  const foodNoBmiCard = document.getElementById('food-no-bmi-card');
  const foodTabContent = document.getElementById('food-tab-content');

  bmiViewFoodBtn.addEventListener('click', () => switchTab('food'));
  foodGoBmiBtn.addEventListener('click', () => switchTab('bmi'));
  applyUnitsUi(unitsSystem);

  const ACTIVITY_MULTIPLIERS = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    active: 1.725,
    veryActive: 1.9,
  };

  const BMI_BANDS = [
    {
      max: 16,
      label: 'Significantly underweight',
      tone: 'cardio-tag',
      note: "Your BMI is significantly below the typical healthy range, which can come with real health risks. Please consider talking to a doctor soon — the targets below are a gentle starting point to help you build back up, not a substitute for medical care.",
    },
    {
      max: 18.5,
      label: 'Underweight',
      tone: 'cardio-tag',
      note: "You're a bit below the typical healthy range — a modest calorie surplus below will help you fuel training and build up steadily.",
    },
    {
      max: 25,
      label: 'Healthy weight',
      tone: '',
      note: "You're right in the typical healthy range — these targets are tuned to help you build muscle while staying there.",
    },
    {
      max: 30,
      label: 'Above healthy range',
      tone: 'cardio-tag',
      note: "You're a bit above the typical healthy range. Small, steady changes go a long way — the targets below favor a gentle deficit while keeping your strength.",
    },
    {
      max: 40,
      label: 'Well above healthy range',
      tone: 'cardio-tag',
      note: 'These targets aim for gradual, sustainable progress while preserving your strength — consistency matters far more than speed here.',
    },
    {
      max: Infinity,
      label: 'Significantly above healthy range',
      tone: 'cardio-tag',
      note: "Your BMI is significantly above the typical healthy range, which can come with real health risks. Please consider talking to a doctor — the targets below are a gentle, gradual starting point, not a substitute for medical care.",
    },
  ];

  function bmiCategory(bmi) {
    return BMI_BANDS.find(band => bmi < band.max) || BMI_BANDS[BMI_BANDS.length - 1];
  }

  function calcNutrition(stats) {
    const totalInches = stats.heightFt * 12 + stats.heightIn;
    const heightCm = totalInches * 2.54;
    const heightM = heightCm / 100;
    const weightKg = stats.weightLb * 0.453592;

    const bmi = weightKg / (heightM * heightM);
    const category = bmiCategory(bmi);

    const bmrBase = 10 * weightKg + 6.25 * heightCm - 5 * stats.age;
    const bmr = stats.sex === 'male' ? bmrBase + 5 : bmrBase - 161;
    const tdee = bmr * (ACTIVITY_MULTIPLIERS[stats.activityLevel] || 1.55);

    let calorieTarget;
    if (bmi >= 30) calorieTarget = tdee - 500;
    else if (bmi >= 25) calorieTarget = tdee - 350;
    else if (bmi < 18.5) calorieTarget = tdee + 350;
    else calorieTarget = tdee + 200; // healthy weight: lean surplus for muscle gain

    const proteinG = stats.weightLb * 0.9; // ~0.8-1g per lb bodyweight, standard muscle-gain range
    const proteinCals = proteinG * 4;
    const fatCals = calorieTarget * 0.27;
    const fatG = fatCals / 9;
    const carbCals = Math.max(0, calorieTarget - proteinCals - fatCals);
    const carbG = carbCals / 4;

    return {
      bmi,
      category,
      calorieTarget: Math.round(calorieTarget),
      proteinG: Math.round(proteinG),
      fatG: Math.round(fatG),
      carbG: Math.round(carbG),
    };
  }

  sexToggleEl.addEventListener('click', e => {
    const chip = e.target.closest('.sex-chip');
    if (!chip) return;
    sexToggleEl.querySelectorAll('.sex-chip').forEach(c => c.classList.toggle('active', c === chip));
  });

  function populateWeightForm(stats) {
    const totalInches = (stats.heightFt ?? 0) * 12 + (stats.heightIn ?? 0);
    if (unitsSystem === 'metric') {
      weightInput.value = stats.weightLb != null ? Math.round(lbToKg(stats.weightLb) * 10) / 10 : '';
      heightCmInput.value = totalInches ? Math.round(inchesToCm(totalInches)) : '';
    } else {
      weightInput.value = stats.weightLb ?? '';
      heightFtInput.value = stats.heightFt ?? '';
      heightInInput.value = stats.heightIn ?? '';
    }
    ageInput.value = stats.age ?? '';
    activitySelect.value = stats.activityLevel || 'moderate';
    sexToggleEl.querySelectorAll('.sex-chip').forEach(c => {
      c.classList.toggle('active', c.dataset.sex === (stats.sex || 'male'));
    });
  }

  let lastNutritionResult = null; // goal macros from the most recent calculation, read by the Food tab

  function renderBmiResults(stats) {
    const result = calcNutrition(stats);
    lastNutritionResult = result;
    weightResultsEl.classList.remove('hidden');
    weightBmiValueEl.textContent = result.bmi.toFixed(1);
    weightBmiTagEl.textContent = result.category.label;
    weightBmiTagEl.className = 'routine-tag' + (result.category.tone ? ' ' + result.category.tone : '');
    weightBmiNoteEl.textContent = result.category.note;
    // BMI this extreme is almost always a typo rather than a real measurement —
    // flag it plainly instead of confidently acting on it.
    weightExtremeNoteEl.textContent = (result.bmi < 10 || result.bmi > 70)
      ? 'These numbers produce an unusual BMI — double-check your height and weight for typos.'
      : '';
  }

  function renderBmiTab() {
    if (!bodyStats) {
      weightResultsEl.classList.add('hidden');
      renderFoodTab();
      return;
    }
    populateWeightForm(bodyStats);
    renderBmiResults(bodyStats);
    renderFoodTab();
  }

  weightCalcBtn.addEventListener('click', () => {
    const enteredWeight = parseFloat(weightInput.value);
    const age = parseInt(ageInput.value, 10);
    const sexChip = sexToggleEl.querySelector('.sex-chip.active');
    const sex = sexChip ? sexChip.dataset.sex : 'male';
    const activityLevel = activitySelect.value;

    let heightFt, heightIn;
    if (unitsSystem === 'metric') {
      const cm = parseFloat(heightCmInput.value) || 0;
      const totalInches = cmToInches(cm);
      heightFt = Math.floor(totalInches / 12);
      heightIn = Math.round((totalInches % 12) * 10) / 10;
    } else {
      heightFt = parseFloat(heightFtInput.value) || 0;
      heightIn = parseFloat(heightInInput.value) || 0;
    }

    if (!enteredWeight || enteredWeight <= 0) {
      alert(`Enter your weight in ${unitsSystem === 'metric' ? 'kilograms' : 'pounds'}.`);
      weightInput.focus();
      return;
    }
    if (heightFt <= 0 && heightIn <= 0) {
      alert('Enter your height.');
      (unitsSystem === 'metric' ? heightCmInput : heightFtInput).focus();
      return;
    }
    if (!age || age <= 0) {
      alert('Enter your age.');
      ageInput.focus();
      return;
    }

    const weightLb = unitsSystem === 'metric' ? kgToLb(enteredWeight) : enteredWeight;

    bodyStats = { weightLb, heightFt, heightIn, age, sex, activityLevel };
    persistLocal();
    schedulePush();
    renderBmiResults(bodyStats);
    renderFoodTab();
  });

  /* ---------------------------------------------------------------------
     FOOD TAB — daily targets (derived from the BMI tab's calculation) +
     the food log below.
  --------------------------------------------------------------------- */
  function renderFoodTab() {
    if (!bodyStats || !lastNutritionResult) {
      foodNoBmiCard.classList.remove('hidden');
      foodTabContent.classList.add('hidden');
      return;
    }
    foodNoBmiCard.classList.add('hidden');
    foodTabContent.classList.remove('hidden');
    weightCaloriesValueEl.textContent = lastNutritionResult.calorieTarget;
    weightProteinValueEl.textContent = lastNutritionResult.proteinG;
    weightCarbsValueEl.textContent = lastNutritionResult.carbG;
    weightFatValueEl.textContent = lastNutritionResult.fatG;
    renderFoodLog();
  }

  /* ---------------------------------------------------------------------
     FOOD LOG — lives inside the Food tab, tracked against the goal macros
     computed on the BMI tab. AI estimate/photo-scan buttons are wired up
     but disabled until a secure backend proxy exists (see README/worker/).
  --------------------------------------------------------------------- */
  const foodDescriptionInput = document.getElementById('food-description-input');
  const foodAiEstimateBtn = document.getElementById('food-ai-estimate-btn');
  const foodPhotoBtn = document.getElementById('food-photo-btn');
  const foodPhotoInput = document.getElementById('food-photo-input');
  const foodLibraryBtn = document.getElementById('food-library-btn');
  const foodLibraryInput = document.getElementById('food-library-input');
  const foodAiNote = document.getElementById('food-ai-note');
  const foodCaloriesInput = document.getElementById('food-calories-input');
  const foodProteinInput = document.getElementById('food-protein-input');
  const foodCarbsInput = document.getElementById('food-carbs-input');
  const foodFatInput = document.getElementById('food-fat-input');
  const foodLogBtn = document.getElementById('food-log-btn');
  const foodLogListEl = document.getElementById('food-log-list');
  const foodLogEmptyMsg = document.getElementById('food-log-empty');
  const foodCalFill = document.getElementById('food-cal-fill');
  const foodCalText = document.getElementById('food-cal-text');
  const foodProteinFill = document.getElementById('food-protein-fill');
  const foodProteinText = document.getElementById('food-protein-text');
  const foodCarbsFill = document.getElementById('food-carbs-fill');
  const foodCarbsText = document.getElementById('food-carbs-text');
  const foodFatFill = document.getElementById('food-fat-fill');
  const foodFatText = document.getElementById('food-fat-text');

  function isToday(isoDate) {
    const d = new Date(isoDate);
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  }

  function setProgressBar(fillEl, textEl, consumed, goal, unit) {
    const pct = goal > 0 ? Math.min(100, Math.round((consumed / goal) * 100)) : 0;
    fillEl.style.width = pct + '%';
    fillEl.classList.toggle('over', goal > 0 && consumed > goal);
    textEl.textContent = `${Math.round(consumed)}${unit} / ${Math.round(goal)}${unit}`;
  }

  function renderFoodLog() {
    const todays = foodLog.filter(f => isToday(f.date)).sort((a, b) => new Date(b.date) - new Date(a.date));

    const totals = todays.reduce((acc, f) => {
      acc.calories += f.calories || 0;
      acc.proteinG += f.proteinG || 0;
      acc.carbG += f.carbG || 0;
      acc.fatG += f.fatG || 0;
      return acc;
    }, { calories: 0, proteinG: 0, carbG: 0, fatG: 0 });

    const goal = lastNutritionResult || { calorieTarget: 0, proteinG: 0, carbG: 0, fatG: 0 };
    setProgressBar(foodCalFill, foodCalText, totals.calories, goal.calorieTarget, '');
    setProgressBar(foodProteinFill, foodProteinText, totals.proteinG, goal.proteinG, 'g');
    setProgressBar(foodCarbsFill, foodCarbsText, totals.carbG, goal.carbG, 'g');
    setProgressBar(foodFatFill, foodFatText, totals.fatG, goal.fatG, 'g');

    foodLogListEl.innerHTML = '';
    foodLogEmptyMsg.classList.toggle('hidden', todays.length > 0);

    todays.forEach(entry => {
      const row = document.createElement('div');
      row.className = 'home-recent-item';

      const left = document.createElement('div');
      const titleDiv = document.createElement('div');
      titleDiv.className = 'home-recent-title';
      titleDiv.textContent = entry.description;
      left.appendChild(titleDiv);

      const detailDiv = document.createElement('div');
      detailDiv.className = 'muted home-recent-date';
      detailDiv.textContent = `${Math.round(entry.calories || 0)} cal  ·  ${Math.round(entry.proteinG || 0)}g P  ·  ${Math.round(entry.carbG || 0)}g C  ·  ${Math.round(entry.fatG || 0)}g F`;
      left.appendChild(detailDiv);

      row.appendChild(left);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn icon-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete entry';
      delBtn.addEventListener('click', () => {
        foodLog = foodLog.filter(f => f.id !== entry.id);
        saveFood();
        renderFoodLog();
      });
      row.appendChild(delBtn);

      foodLogListEl.appendChild(row);
    });
  }

  foodLogBtn.addEventListener('click', () => {
    const description = foodDescriptionInput.value.trim();
    if (!description) {
      alert('Enter what you ate.');
      foodDescriptionInput.focus();
      return;
    }
    const calories = parseFloat(foodCaloriesInput.value) || 0;
    const proteinG = parseFloat(foodProteinInput.value) || 0;
    const carbG = parseFloat(foodCarbsInput.value) || 0;
    const fatG = parseFloat(foodFatInput.value) || 0;

    if (!calories && !proteinG && !carbG && !fatG) {
      alert('Enter at least an estimated calorie or macro amount.');
      foodCaloriesInput.focus();
      return;
    }

    foodLog.unshift({
      id: uid(),
      date: new Date().toISOString(),
      description,
      calories,
      proteinG,
      carbG,
      fatG,
    });
    saveFood();

    foodDescriptionInput.value = '';
    foodCaloriesInput.value = '';
    foodProteinInput.value = '';
    foodCarbsInput.value = '';
    foodFatInput.value = '';
    renderFoodLog();
    renderHome();
  });

  // AI estimate / photo scan call the Worker proxy in worker/ (see
  // worker/README.md to deploy it) — the buttons stay disabled until
  // AI_ESTIMATE_ENDPOINT (ai-config.js) is set to a real deployed URL.
  const AI_ENABLED = Boolean(AI_ESTIMATE_ENDPOINT);

  if (AI_ENABLED) {
    foodAiEstimateBtn.disabled = false;
    foodPhotoBtn.disabled = false;
    foodLibraryBtn.disabled = false;
    foodAiNote.classList.add('hidden');
  }

  async function callAiEstimate(payload) {
    const res = await fetch(AI_ESTIMATE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || `Request failed (${res.status})`);
    }
    return res.json();
  }

  function fillFoodFieldsFromEstimate(estimate) {
    if (estimate.label && !foodDescriptionInput.value.trim()) {
      foodDescriptionInput.value = estimate.label;
    }
    foodCaloriesInput.value = Math.round(estimate.calories || 0);
    foodProteinInput.value = Math.round(estimate.proteinG || 0);
    foodCarbsInput.value = Math.round(estimate.carbG || 0);
    foodFatInput.value = Math.round(estimate.fatG || 0);
  }

  foodAiEstimateBtn.addEventListener('click', async () => {
    if (!AI_ENABLED) return;
    const description = foodDescriptionInput.value.trim();
    if (!description) {
      alert('Describe what you ate first (e.g. "grilled chicken breast, 200g").');
      foodDescriptionInput.focus();
      return;
    }
    const originalLabel = foodAiEstimateBtn.textContent;
    foodAiEstimateBtn.disabled = true;
    foodAiEstimateBtn.textContent = 'Estimating…';
    foodAiNote.classList.remove('hidden');
    foodAiNote.textContent = 'Asking AI to estimate the macros…';
    try {
      const estimate = await callAiEstimate({ description });
      fillFoodFieldsFromEstimate(estimate);
      foodAiNote.textContent = 'Estimate filled in below — double check before adding.';
    } catch (err) {
      console.error('AI estimate failed', err);
      foodAiNote.textContent = 'Could not get an AI estimate: ' + err.message;
    } finally {
      foodAiEstimateBtn.disabled = false;
      foodAiEstimateBtn.textContent = originalLabel;
    }
  });

  foodPhotoBtn.addEventListener('click', () => {
    if (!AI_ENABLED) return;
    foodPhotoInput.click();
  });

  foodLibraryBtn.addEventListener('click', () => {
    if (!AI_ENABLED) return;
    foodLibraryInput.click();
  });

  async function handleFoodPhotoFile(file, triggerBtn, triggerInput) {
    if (!file) return;
    // Whatever the user typed here before picking a photo is a clarifying
    // note (e.g. "french toast with berries, not chocolate cake") — send it
    // along with the image, and don't let the AI's own guessed label
    // clobber it afterward (fillFoodFieldsFromEstimate already only fills
    // the description when it's empty).
    const userNote = foodDescriptionInput.value.trim();
    const originalLabel = triggerBtn.textContent;
    foodPhotoBtn.disabled = true;
    foodLibraryBtn.disabled = true;
    triggerBtn.textContent = 'Scanning…';
    foodAiNote.classList.remove('hidden');
    foodAiNote.textContent = 'Scanning photo…';
    try {
      const imageBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const payload = { imageBase64, mimeType: file.type || 'image/jpeg' };
      if (userNote) payload.description = userNote;
      const estimate = await callAiEstimate(payload);
      fillFoodFieldsFromEstimate(estimate);
      foodAiNote.textContent = 'Estimate filled in below — double check before adding.';
    } catch (err) {
      console.error('AI photo scan failed', err);
      foodAiNote.textContent = 'Could not scan that photo: ' + err.message;
    } finally {
      foodPhotoBtn.disabled = false;
      foodLibraryBtn.disabled = false;
      triggerBtn.textContent = originalLabel;
      triggerInput.value = '';
    }
  }

  foodPhotoInput.addEventListener('change', () => {
    const file = foodPhotoInput.files && foodPhotoInput.files[0];
    handleFoodPhotoFile(file, foodPhotoBtn, foodPhotoInput);
  });

  foodLibraryInput.addEventListener('change', () => {
    const file = foodLibraryInput.files && foodLibraryInput.files[0];
    handleFoodPhotoFile(file, foodLibraryBtn, foodLibraryInput);
  });

  /* ---------------------------------------------------------------------
     HISTORY TAB — a unified, date-sorted feed of strength workouts + cardio
  --------------------------------------------------------------------- */
  const historyListEl = document.getElementById('history-list');
  const noHistoryMsg = document.getElementById('no-history-msg');

  const expandedHistoryIds = new Set();
  let editingEntryId = null;
  let editingEntryType = null; // 'strength' | 'cardio'
  let historyEditExercises = null; // working draft while editing a strength entry
  let cardioEditDraft = null; // working draft while editing a cardio entry

  // Merges strength history + cardio sessions into one date-sorted feed.
  // Shared by the History tab and the Home tab's recent-activity preview.
  function getCombinedEntries() {
    return [
      ...history.map(h => ({ ...h, type: 'strength' })),
      ...cardioLog.map(c => ({ ...c, type: 'cardio' })),
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  function startEditStrength(entry) {
    editingEntryId = entry.id;
    editingEntryType = 'strength';
    historyEditExercises = JSON.parse(JSON.stringify(entry.exercises));
    expandedHistoryIds.add(entry.id);
    renderHistoryList();
  }

  function startEditCardioEntry(entry) {
    editingEntryId = entry.id;
    editingEntryType = 'cardio';
    cardioEditDraft = {
      machine: entry.machine,
      incline: entry.incline,
      speed: entry.speed,
      durationMinutes: entry.durationMinutes,
    };
    expandedHistoryIds.add(entry.id);
    renderHistoryList();
  }

  function cancelEditEntry() {
    editingEntryId = null;
    editingEntryType = null;
    historyEditExercises = null;
    cardioEditDraft = null;
    renderHistoryList();
  }

  function saveEditStrength(entry) {
    const real = history.find(h => h.id === entry.id);
    if (!real) return;
    const cleaned = historyEditExercises
      .map(ex => ({
        name: ex.name,
        sets: ex.sets
          .filter(s => (s.weight !== '' && s.weight != null) || (s.reps !== '' && s.reps != null))
          .map(s => ({ weight: s.weight || '0', reps: s.reps || '0' })),
      }))
      .filter(ex => ex.sets.length > 0);

    if (cleaned.length === 0) {
      alert('A workout needs at least one logged set. Add a set, or delete this entry instead.');
      return;
    }

    real.exercises = cleaned;
    saveHistory();
    cancelEditEntry();
    renderHome();
  }

  function saveEditCardioEntry(entry) {
    const real = cardioLog.find(c => c.id === entry.id);
    if (!real) return;
    const machine = (cardioEditDraft.machine || '').trim();
    const duration = parseFloat(cardioEditDraft.durationMinutes);
    if (!machine) {
      alert('Enter a machine or activity.');
      return;
    }
    if (!duration || duration <= 0) {
      alert('Enter a valid duration.');
      return;
    }
    real.machine = machine;
    real.incline = (cardioEditDraft.incline ?? '').toString().trim() || null;
    real.speed = (cardioEditDraft.speed ?? '').toString().trim() || null;
    real.durationMinutes = duration;
    saveCardio();
    cancelEditEntry();
    renderHome();
  }

  // Builds the inline editable fields (machine, incline, speed, duration) for a cardio draft.
  function buildCardioFieldsEditor(draft) {
    const wrap = document.createElement('div');
    wrap.className = 'cardio-form';

    const machineLabel = document.createElement('label');
    machineLabel.className = 'field-label';
    machineLabel.textContent = 'Machine / activity';
    wrap.appendChild(machineLabel);
    const machineInput = document.createElement('input');
    machineInput.type = 'text';
    machineInput.value = draft.machine || '';
    machineInput.addEventListener('input', () => { draft.machine = machineInput.value; });
    wrap.appendChild(machineInput);

    const row = document.createElement('div');
    row.className = 'cardio-form-row';

    const inclineField = document.createElement('div');
    inclineField.className = 'cardio-field';
    const inclineLabel = document.createElement('label');
    inclineLabel.className = 'field-label';
    inclineLabel.textContent = 'Incline';
    inclineField.appendChild(inclineLabel);
    const inclineInput = document.createElement('input');
    inclineInput.type = 'number';
    inclineInput.step = 'any';
    inclineInput.value = draft.incline ?? '';
    inclineInput.addEventListener('input', () => { draft.incline = inclineInput.value; });
    inclineField.appendChild(inclineInput);
    row.appendChild(inclineField);

    const speedField = document.createElement('div');
    speedField.className = 'cardio-field';
    const speedLabel = document.createElement('label');
    speedLabel.className = 'field-label';
    speedLabel.textContent = 'Speed';
    speedField.appendChild(speedLabel);
    const speedInput = document.createElement('input');
    speedInput.type = 'number';
    speedInput.step = 'any';
    speedInput.value = draft.speed ?? '';
    speedInput.addEventListener('input', () => { draft.speed = speedInput.value; });
    speedField.appendChild(speedInput);
    row.appendChild(speedField);

    wrap.appendChild(row);

    const durationLabel = document.createElement('label');
    durationLabel.className = 'field-label';
    durationLabel.textContent = 'Duration (minutes)';
    wrap.appendChild(durationLabel);
    const durationInput = document.createElement('input');
    durationInput.type = 'number';
    durationInput.step = 'any';
    durationInput.value = draft.durationMinutes ?? '';
    durationInput.addEventListener('input', () => { draft.durationMinutes = durationInput.value; });
    wrap.appendChild(durationInput);

    return wrap;
  }

  // Builds an editable exercise list (name, sets, add/remove) bound to `exercises`,
  // calling `onStructureChange` after any add/remove so the caller can re-render.
  function buildHistoryExerciseEditor(exercises, onStructureChange) {
    const wrap = document.createElement('div');

    exercises.forEach((ex, exIdx) => {
      const block = document.createElement('div');
      block.className = 'exercise-block';

      const header = document.createElement('div');
      header.className = 'exercise-header';
      const h3 = document.createElement('h3');
      h3.textContent = ex.name;
      header.appendChild(h3);

      const removeExerciseBtn = document.createElement('button');
      removeExerciseBtn.className = 'btn icon-btn';
      removeExerciseBtn.title = 'Remove exercise';
      removeExerciseBtn.textContent = '✕';
      removeExerciseBtn.addEventListener('click', () => {
        exercises.splice(exIdx, 1);
        onStructureChange();
      });
      header.appendChild(removeExerciseBtn);
      block.appendChild(header);

      const table = document.createElement('table');
      table.className = 'sets-table';
      table.innerHTML = '<thead><tr><th></th><th>Weight</th><th>Reps</th><th></th></tr></thead>';
      const tbody = document.createElement('tbody');

      ex.sets.forEach((set, setIdx) => {
        const tr = document.createElement('tr');

        const numTd = document.createElement('td');
        numTd.className = 'set-num';
        numTd.textContent = setIdx + 1;
        tr.appendChild(numTd);

        const weightTd = document.createElement('td');
        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.min = '0';
        weightInput.step = 'any';
        weightInput.placeholder = '0';
        weightInput.value = set.weight ?? '';
        weightInput.addEventListener('input', () => { set.weight = weightInput.value; });
        weightTd.appendChild(weightInput);
        tr.appendChild(weightTd);

        const repsTd = document.createElement('td');
        const repsInput = document.createElement('input');
        repsInput.type = 'number';
        repsInput.min = '0';
        repsInput.step = '1';
        repsInput.placeholder = '0';
        repsInput.value = set.reps ?? '';
        repsInput.addEventListener('input', () => { set.reps = repsInput.value; });
        repsTd.appendChild(repsInput);
        tr.appendChild(repsTd);

        const delTd = document.createElement('td');
        const delBtn = document.createElement('button');
        delBtn.className = 'btn icon-btn';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete set';
        delBtn.addEventListener('click', () => {
          ex.sets.splice(setIdx, 1);
          onStructureChange();
        });
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      block.appendChild(table);

      const addSetBtn = document.createElement('button');
      addSetBtn.className = 'add-set-btn';
      addSetBtn.textContent = '+ Add set';
      addSetBtn.addEventListener('click', () => {
        const last = ex.sets[ex.sets.length - 1];
        ex.sets.push({ weight: last ? last.weight : '', reps: last ? last.reps : '' });
        onStructureChange();
      });
      block.appendChild(addSetBtn);

      wrap.appendChild(block);
    });

    const addExerciseRow = document.createElement('div');
    addExerciseRow.className = 'row add-exercise-row';
    const newExInput = document.createElement('input');
    newExInput.type = 'text';
    newExInput.placeholder = 'Add exercise…';
    const newExBtn = document.createElement('button');
    newExBtn.className = 'btn ghost';
    newExBtn.textContent = '+ Add exercise';
    const commitNewExercise = () => {
      const name = newExInput.value.trim();
      if (!name) return;
      exercises.push({ name, sets: [] });
      onStructureChange();
    };
    newExBtn.addEventListener('click', commitNewExercise);
    newExInput.addEventListener('keydown', e => { if (e.key === 'Enter') commitNewExercise(); });
    addExerciseRow.appendChild(newExInput);
    addExerciseRow.appendChild(newExBtn);
    wrap.appendChild(addExerciseRow);

    return wrap;
  }

  function renderHistoryList() {
    historyListEl.innerHTML = '';
    const combined = getCombinedEntries();
    noHistoryMsg.classList.toggle('hidden', combined.length > 0);

    combined.forEach(entry => {
      const isEditing = editingEntryId === entry.id;
      const isOpen = isEditing || expandedHistoryIds.has(entry.id);
      const isCardio = entry.type === 'cardio';

      const item = document.createElement('div');
      item.className = 'history-item';

      const head = document.createElement('div');
      head.className = 'history-item-head';

      const left = document.createElement('div');
      const dateEl = document.createElement('div');
      dateEl.className = 'history-item-date';
      dateEl.textContent = formatDate(entry.date);
      left.appendChild(dateEl);

      const tag = document.createElement('span');
      tag.className = isCardio ? 'routine-tag cardio-tag' : 'routine-tag';
      tag.textContent = isCardio ? 'Cardio' : entry.routineName;
      left.appendChild(tag);

      head.appendChild(left);

      const caret = document.createElement('span');
      caret.className = 'muted';
      caret.textContent = isOpen ? '▴' : '▾';
      head.appendChild(caret);

      item.appendChild(head);

      const details = document.createElement('div');
      details.className = 'history-item-details' + (isOpen ? ' open' : '');

      if (isEditing && isCardio) {
        details.appendChild(buildCardioFieldsEditor(cardioEditDraft));

        const editActions = document.createElement('div');
        editActions.className = 'row history-item-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn primary small';
        saveBtn.textContent = 'Save changes';
        saveBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          saveEditCardioEntry(entry);
        });
        editActions.appendChild(saveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn ghost small';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          cancelEditEntry();
        });
        editActions.appendChild(cancelBtn);

        details.appendChild(editActions);
      } else if (isEditing) {
        details.appendChild(
          buildHistoryExerciseEditor(historyEditExercises, () => renderHistoryList())
        );

        const editActions = document.createElement('div');
        editActions.className = 'row history-item-actions';

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn primary small';
        saveBtn.textContent = 'Save changes';
        saveBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          saveEditStrength(entry);
        });
        editActions.appendChild(saveBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn ghost small';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          cancelEditEntry();
        });
        editActions.appendChild(cancelBtn);

        details.appendChild(editActions);
      } else if (isCardio) {
        const nameDiv = document.createElement('div');
        nameDiv.className = 'history-exercise-name';
        nameDiv.textContent = entry.machine;
        details.appendChild(nameDiv);

        const detailBits = [`${entry.durationMinutes} min`];
        if (entry.speed) detailBits.push(`${entry.speed} speed`);
        if (entry.incline) detailBits.push(`${entry.incline} incline`);
        const detailDiv = document.createElement('div');
        detailDiv.className = 'history-sets';
        detailDiv.textContent = detailBits.join('  ·  ');
        details.appendChild(detailDiv);

        const actions = document.createElement('div');
        actions.className = 'row history-item-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'btn ghost small';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          startEditCardioEntry(entry);
        });
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'btn ghost small';
        delBtn.textContent = 'Delete entry';
        delBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!confirm('Delete this cardio session?')) return;
          cardioLog = cardioLog.filter(c => c.id !== entry.id);
          saveCardio();
          renderHistoryList();
          renderHome();
        });
        actions.appendChild(delBtn);

        details.appendChild(actions);
      } else {
        entry.exercises.forEach(ex => {
          const exDiv = document.createElement('div');
          exDiv.className = 'history-exercise';
          const nameDiv = document.createElement('div');
          nameDiv.className = 'history-exercise-name';
          nameDiv.textContent = ex.name;
          exDiv.appendChild(nameDiv);

          const setsDiv = document.createElement('div');
          setsDiv.className = 'history-sets';
          setsDiv.textContent = ex.sets
            .map((s, i) => `Set ${i + 1}: ${s.weight} × ${s.reps}`)
            .join('  ·  ');
          exDiv.appendChild(setsDiv);

          details.appendChild(exDiv);
        });

        const actions = document.createElement('div');
        actions.className = 'row history-item-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'btn ghost small';
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          startEditStrength(entry);
        });
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'btn ghost small';
        delBtn.textContent = 'Delete entry';
        delBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          if (!confirm('Delete this workout from history?')) return;
          history = history.filter(h => h.id !== entry.id);
          saveHistory();
          renderHistoryList();
          renderHome();
        });
        actions.appendChild(delBtn);

        details.appendChild(actions);
      }

      item.appendChild(details);

      head.addEventListener('click', () => {
        if (isEditing) return;
        if (expandedHistoryIds.has(entry.id)) {
          expandedHistoryIds.delete(entry.id);
        } else {
          expandedHistoryIds.add(entry.id);
        }
        renderHistoryList();
      });

      historyListEl.appendChild(item);
    });
  }

  /* ---------------------------------------------------------------------
     REST TIMER
  --------------------------------------------------------------------- */
  const timerDisplay = document.getElementById('timer-display');
  const timerSecondsInput = document.getElementById('timer-seconds-input');
  const timerStartBtn = document.getElementById('timer-start-btn');
  const timerPauseBtn = document.getElementById('timer-pause-btn');
  const timerResetBtn = document.getElementById('timer-reset-btn');
  const restTimerEl = document.getElementById('rest-timer');
  const timerRingProgress = document.getElementById('timer-ring-progress');
  const timerPresetsEl = document.getElementById('timer-presets');
  const timerMinus15Btn = document.getElementById('timer-minus15-btn');
  const timerPlus15Btn = document.getElementById('timer-plus15-btn');
  const timerRingWrapBtn = document.getElementById('timer-ring-wrap');

  // iOS Safari mutes any AudioContext that wasn't created/resumed inside a
  // direct user-gesture call stack — creating a brand-new context at the
  // exact moment the timer finishes (no gesture, it's a setInterval/visibility
  // callback) is exactly what iOS silently blocks. The fix is to unlock ONE
  // context early, during a real tap, and keep reusing that same instance —
  // once unlocked it stays unlocked for the rest of the session.
  let sharedAudioCtx = null;
  function unlockAudioContext() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!sharedAudioCtx) sharedAudioCtx = new AudioCtx();
      if (sharedAudioCtx.state === 'suspended') sharedAudioCtx.resume();
    } catch (e) {
      console.warn('Audio unlock unavailable', e);
    }
  }

  timerRingWrapBtn.addEventListener('click', () => {
    restTimerEl.classList.toggle('collapsed');
    unlockAudioContext();
  });

  const RING_RADIUS = 52;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  timerRingProgress.style.strokeDasharray = String(RING_CIRCUMFERENCE);

  const LS_TIMER = 'gymtracker_timer_state';

  let timerTotalSeconds = 90;
  let timerRemaining = 90; // authoritative only when idle/paused — see getRemainingSeconds()
  let timerEndAt = null; // epoch ms the countdown reaches zero; set only while running
  let timerIntervalId = null;
  let timerRunning = false;
  const originalTitle = document.title;

  // Wall-clock based, not tick-counted — a backgrounded tab gets its JS timers
  // throttled or suspended by the browser, so counting down "-1 per tick" drifts
  // or stalls. Deriving remaining time from an absolute end-timestamp means the
  // countdown is always correct the instant we get a chance to check it again,
  // whether that's the next tick or the moment the app comes back to the foreground.
  function getRemainingSeconds() {
    if (timerRunning && timerEndAt) {
      return Math.max(0, Math.round((timerEndAt - Date.now()) / 1000));
    }
    return timerRemaining;
  }

  function persistTimerState() {
    save(LS_TIMER, { timerTotalSeconds, timerRemaining, timerEndAt, timerRunning });
  }

  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  function renderTimer() {
    const remaining = getRemainingSeconds();
    timerDisplay.textContent = formatTime(remaining);

    const fraction = timerTotalSeconds > 0 ? remaining / timerTotalSeconds : 0;
    const offset = RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, fraction)));
    timerRingProgress.style.strokeDashoffset = String(offset);

    timerRingProgress.classList.toggle('low', remaining > 0 && remaining <= 10);
    timerRingProgress.classList.toggle('done', remaining <= 0 && restTimerEl.classList.contains('alerting'));

    timerPresetsEl.querySelectorAll('.preset-chip').forEach(chip => {
      chip.classList.toggle('active', Number(chip.dataset.secs) === timerTotalSeconds);
    });
  }

  function stopAlerting() {
    restTimerEl.classList.remove('alerting');
    document.title = originalTitle;
    renderTimer();
  }

  function playBeep() {
    if (!timerSoundEnabled) return;
    try {
      // Reuse (and re-unlock if needed) the shared context instead of
      // creating a fresh one here — see unlockAudioContext() above for why
      // that specifically breaks silently on iOS.
      unlockAudioContext();
      const ctx = sharedAudioCtx;
      if (!ctx) return;
      // 0-100 slider maps to a peak gain of roughly 0.12-0.95 — noticeably
      // louder ceiling than a fixed beep, while staying just under clipping.
      const peakGain = 0.12 + (timerVolume / 100) * 0.83;
      const beepOnce = (startTime) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.28);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.3);
      };
      const now = ctx.currentTime;
      // Higher volumes also get an extra couple of beeps — louder AND more
      // insistent, closer to an actual alarm rather than a gentle chime.
      const repeatCount = timerVolume >= 60 ? 5 : 3;
      for (let i = 0; i < repeatCount; i++) beepOnce(now + i * 0.4);
    } catch (e) {
      console.warn('Audio alert unavailable', e);
    }
  }

  function vibrateAlert() {
    if (!timerVibrateEnabled) return;
    if (navigator.vibrate) {
      navigator.vibrate([250, 100, 250, 100, 250]);
    }
  }

  function onTimerDone() {
    timerRunning = false;
    timerEndAt = null;
    timerRemaining = 0;
    timerIntervalId && clearInterval(timerIntervalId);
    timerIntervalId = null;
    timerStartBtn.textContent = 'Start';
    timerStartBtn.classList.remove('hidden');
    timerPauseBtn.classList.add('hidden');
    playBeep();
    vibrateAlert();
    restTimerEl.classList.add('alerting');
    restTimerEl.classList.remove('collapsed'); // impossible to miss when rest is actually over
    renderTimer();
    persistTimerState();
    let flip = false;
    const flashInterval = setInterval(() => {
      document.title = flip ? originalTitle : '⏰ Rest over!';
      flip = !flip;
    }, 800);
    setTimeout(() => { clearInterval(flashInterval); stopAlerting(); }, 6000);
  }

  function pulseDisplay() {
    timerDisplay.classList.remove('tick');
    void timerDisplay.offsetWidth; // force reflow so the animation restarts every tick
    timerDisplay.classList.add('tick');
  }

  function tick() {
    pulseDisplay();
    if (getRemainingSeconds() <= 0) {
      onTimerDone();
      return;
    }
    renderTimer();
  }

  function startTimer() {
    unlockAudioContext(); // real tap — the reliable place to unlock iOS audio
    stopAlerting();
    const remaining = getRemainingSeconds();
    if (remaining <= 0) {
      timerTotalSeconds = Math.max(5, parseInt(timerSecondsInput.value, 10) || defaultRestSeconds);
      timerRemaining = timerTotalSeconds;
    } else {
      timerRemaining = remaining;
    }
    timerRunning = true;
    timerEndAt = Date.now() + timerRemaining * 1000;
    timerStartBtn.classList.add('hidden');
    timerPauseBtn.classList.remove('hidden');
    timerIntervalId = setInterval(tick, 1000);
    persistTimerState();
    renderTimer();
  }

  function pauseTimer() {
    timerRemaining = getRemainingSeconds();
    timerRunning = false;
    timerEndAt = null;
    timerIntervalId && clearInterval(timerIntervalId);
    timerIntervalId = null;
    timerStartBtn.textContent = 'Resume';
    timerStartBtn.classList.remove('hidden');
    timerPauseBtn.classList.add('hidden');
    persistTimerState();
  }

  function resetTimer() {
    timerRunning = false;
    timerEndAt = null;
    timerIntervalId && clearInterval(timerIntervalId);
    timerIntervalId = null;
    timerTotalSeconds = Math.max(5, parseInt(timerSecondsInput.value, 10) || defaultRestSeconds);
    timerRemaining = timerTotalSeconds;
    timerStartBtn.textContent = 'Start';
    timerStartBtn.classList.remove('hidden');
    timerPauseBtn.classList.add('hidden');
    stopAlerting();
    persistTimerState();
    renderTimer();
  }

  timerStartBtn.addEventListener('click', startTimer);
  timerPauseBtn.addEventListener('click', pauseTimer);
  timerResetBtn.addEventListener('click', resetTimer);
  timerSecondsInput.addEventListener('change', () => {
    if (!timerRunning) {
      timerTotalSeconds = Math.max(5, parseInt(timerSecondsInput.value, 10) || defaultRestSeconds);
      timerRemaining = timerTotalSeconds;
      timerStartBtn.textContent = 'Start';
      persistTimerState();
      renderTimer();
    }
  });

  function nudgeTimer(delta) {
    stopAlerting();
    if (timerRunning) {
      const remaining = Math.max(5, getRemainingSeconds() + delta);
      timerRemaining = remaining;
      if (remaining > timerTotalSeconds) timerTotalSeconds = remaining;
      timerEndAt = Date.now() + remaining * 1000;
    } else {
      timerTotalSeconds = Math.max(5, timerTotalSeconds + delta);
      timerRemaining = timerTotalSeconds;
    }
    timerSecondsInput.value = timerTotalSeconds;
    persistTimerState();
    renderTimer();
  }

  timerMinus15Btn.addEventListener('click', () => nudgeTimer(-15));
  timerPlus15Btn.addEventListener('click', () => nudgeTimer(15));

  timerPresetsEl.addEventListener('click', e => {
    const chip = e.target.closest('.preset-chip');
    if (!chip) return;
    const secs = Number(chip.dataset.secs);
    timerSecondsInput.value = secs;
    if (!timerRunning) {
      timerTotalSeconds = secs;
      timerRemaining = secs;
      timerStartBtn.textContent = 'Start';
      stopAlerting();
      persistTimerState();
    }
  });

  // The moment the tab/app comes back into view, immediately resync from the
  // wall clock instead of waiting for the next (possibly delayed) tick — this
  // is what makes rest-over catch up right away rather than staying stale.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !timerRunning) return;
    if (getRemainingSeconds() <= 0) {
      timerIntervalId && clearInterval(timerIntervalId);
      timerIntervalId = null;
      onTimerDone();
    } else {
      renderTimer();
    }
  });

  // Restores timer state across full reloads/relaunches (e.g. iOS reclaiming a
  // backgrounded tab's memory) — a running timer picks up exactly where the
  // wall clock says it should be, including firing the done-state immediately
  // if time already ran out while the app was closed.
  function restoreTimerState() {
    const saved = load(LS_TIMER, null);
    if (!saved) {
      timerTotalSeconds = defaultRestSeconds;
      timerRemaining = defaultRestSeconds;
      timerSecondsInput.value = defaultRestSeconds;
      renderTimer();
      return;
    }
    timerTotalSeconds = saved.timerTotalSeconds || defaultRestSeconds;
    timerSecondsInput.value = timerTotalSeconds;

    if (saved.timerRunning && saved.timerEndAt) {
      timerEndAt = saved.timerEndAt;
      timerRunning = true;
      if (getRemainingSeconds() <= 0) {
        onTimerDone();
      } else {
        timerRemaining = getRemainingSeconds();
        timerStartBtn.classList.add('hidden');
        timerPauseBtn.classList.remove('hidden');
        timerIntervalId = setInterval(tick, 1000);
        renderTimer();
      }
    } else {
      timerRemaining = typeof saved.timerRemaining === 'number' ? saved.timerRemaining : timerTotalSeconds;
      if (timerRemaining > 0 && timerRemaining < timerTotalSeconds) {
        timerStartBtn.textContent = 'Resume';
      }
      renderTimer();
    }
  }

  /* ---------------------------------------------------------------------
     Init
  --------------------------------------------------------------------- */
  renderRoutineSelect();
  renderRoutinesList();
  renderHistoryList();
  renderActiveWorkout();
  renderHome();
  renderBmiTab();
  restoreTimerState();
})();

// Safety net: force-hide the loading screen even if app.js threw before reaching init.
setTimeout(() => {
  const el = document.getElementById('loading-screen');
  if (el) el.classList.add('hide');
}, 4000);
