// Read-only check that the AWS S3 SDK (R2) works inside the omx-api Worker:
// lists product images as a throwaway admin user, then removes that user.
import { getPlatformProxy } from 'wrangler';
import { Store } from '../cf/store.js';

const KEY = 'AIzaSyCFfeTweRCrvjKp8ScXKTvL7jwI_4vmvQU';
const { env, dispose } = await getPlatformProxy({ configPath: '../cf/wrangler.toml', persist: { path: '../cf/.wrangler/state/v3' } });
const store = new Store(env.DB);
const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `omx-d1-test-r2-${Date.now()}@example.com`, password: 'Test-' + crypto.randomUUID(), returnSecureToken: true }),
});
const u = await r.json();
try {
    await store.commit([{ op: 'set', path: `users/${u.localId}`, data: { roles: ['admin'] } }]);
    const res = await fetch('http://127.0.0.1:8799/api/upload/product-images', { headers: { 'x-server-secret': u.idToken } });
    const body = await res.json();
    console.log(res.status, Array.isArray(body.images) ? `${body.images.length} images listed` : JSON.stringify(body).slice(0, 300));
} finally {
    await store.commit([{ op: 'delete', path: `users/${u.localId}` }]);
    await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${KEY}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: u.idToken }),
    });
    await dispose();
}
