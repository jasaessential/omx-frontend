/* ═══════════════════════════════════════════════
   JASA V2 — catalog-sync.js
   Live "catalog changed" signal for the storefront.

   manage-items.js bumps metadata/catalog_version.{category}
   after every create / edit / delete (once the Worker cache is
   refreshed). Any page that calls watchCatalog() is told the moment
   that happens, so new or changed products show up immediately
   instead of after the per-tab cache expires.
   ═══════════════════════════════════════════════ */
import { db } from './firebase-init.js';
import { doc, onSnapshot }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const VER_KEY    = cat => `jasa_v2_catver_${cat}`;
const CACHE_KEYS = cat => [`jasa_v2_cat_${cat}`, `jasa_v2_hcat_${cat}`];

function ss(fn) { try { return fn(sessionStorage); } catch (_) { return null; } }

/** onChange(cat) fires when a category's items changed since this tab last saw them. */
export function watchCatalog(onChange) {
    try {
        return onSnapshot(doc(db, 'metadata', 'catalog_version'), snap => {
            const versions = snap.exists() ? snap.data() : {};
            for (const [cat, raw] of Object.entries(versions)) {
                if (cat === 'updatedAt') continue;
                const ver    = String(raw);
                const stored = ss(s => s.getItem(VER_KEY(cat)));
                if (stored === ver) continue;

                const hadCache = CACHE_KEYS(cat).some(k => ss(s => s.getItem(k)));
                ss(s => {
                    CACHE_KEYS(cat).forEach(k => s.removeItem(k));
                    s.setItem(VER_KEY(cat), ver);
                });
                /* Brand-new tab with nothing cached: the page is already loading fresh data */
                if (stored === null && !hadCache) continue;
                onChange(cat);
            }
        }, err => console.warn('[catalog-sync]', err.message));
    } catch (e) {
        console.warn('[catalog-sync] unavailable:', e.message);
        return () => {};
    }
}
