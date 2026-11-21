/* ═══════════════════════════════════════════════
   JASA V2 — Firebase Initialization
   Firebase client config is public by design —
   security is enforced via Firestore Rules, not
   by hiding the config. No server fetch needed.
   ═══════════════════════════════════════════════ */

import { initializeApp }        from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth, GoogleAuthProvider }
    from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import {
    initializeFirestore,
    memoryLocalCache
} from "./cf-firestore.js";
import { getAnalytics }         from "https://www.gstatic.com/firebasejs/10.8.0/firebase-analytics.js";

const FIREBASE_CONFIG = {
    apiKey:            "AIzaSyCFfeTweRCrvjKp8ScXKTvL7jwI_4vmvQU",
    authDomain:        "jasa-essential-234f8.firebaseapp.com",
    projectId:         "jasa-essential-234f8",
    storageBucket:     "jasa-essential-234f8.firebasestorage.app",
    messagingSenderId: "897065666607",
    appId:             "1:897065666607:web:d5784f376b24c3f9b01eda",
    measurementId:     "G-Z40CTNGMNV"
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);

/* No on-device Firestore cache (IndexedDB): every page load reads live data.
   The memory cache only lives for the current page. Old IndexedDB copies are
   deleted by the startup cleanup in head-cache.js. */
const db = initializeFirestore(app, {
    localCache: memoryLocalCache()
});

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

let analytics = null;
try { analytics = getAnalytics(app); } catch (_) {}

export { app, auth, db, googleProvider, analytics };
