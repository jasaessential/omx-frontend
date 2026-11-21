"""Signed-in check of the order-notification card (omx-push.js) on the local site.
Creates a throwaway Firebase Auth user, signs in inside the page, checks the
card appears, clicks "Turn on" with permission granted, then deletes the user."""
import os, json, time, urllib.request
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', r'D:\Studio\claude-seo\ms-playwright')
from playwright.sync_api import sync_playwright

KEY = 'AIzaSyCFfeTweRCrvjKp8ScXKTvL7jwI_4vmvQU'
def call(ep, body):
    req = urllib.request.Request(f'https://identitytoolkit.googleapis.com/v1/accounts:{ep}?key={KEY}',
                                 data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req))

email, pw = f'omx-d1-test-card-{int(time.time())}@example.com', 'Test-' + os.urandom(8).hex()
u = call('signUp', {'email': email, 'password': pw, 'returnSecureToken': True})
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 412, 'height': 900})
        ctx.add_init_script("Object.defineProperty(Notification, 'permission', { get: () => window.__perm || 'default' }); Notification.requestPermission = async () => (window.__perm = 'granted');")
        pg = ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('response', lambda r: errs.append(f'{r.status} {r.url}') if r.status >= 400 else None)
        pg.goto('http://localhost:5500/index.html', wait_until='networkidle')
        pg.evaluate("""async ([e, p]) => {
            const { auth } = await import('/firebase-init.js');
            const { signInWithEmailAndPassword } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
            await signInWithEmailAndPassword(auth, e, p);
        }""", [email, pw])
        pg.reload(wait_until='networkidle')
        pg.wait_for_timeout(4500)
        print("debug:", pg.evaluate("""async () => { const m = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js'); return { perm: Notification.permission, push: 'PushManager' in window, sup: await m.isSupported(), booted: !!window.__omxPushBooted, user: !!(await import('/firebase-init.js')).auth.currentUser }; }"""))
        card = pg.query_selector('#omxPushCard')
        print('card shown:', bool(card), '|', card.inner_text().replace('\n', ' / ') if card else '')
        pg.screenshot(path=os.path.join(os.path.dirname(__file__), 'shots', 'push-card.png'))
        ctx.grant_permissions(['notifications'], origin='http://localhost:5500')
        if card:
            pg.click('#omxPushCard .omxp-on')
            pg.wait_for_timeout(8000)
            print('token saved:', pg.evaluate("""async () => { const { auth, db } = await import('/firebase-init.js'); const { doc, getDoc } = await import('/cf-firestore.js'); const s = await getDoc(doc(db, 'users', auth.currentUser.uid)); return s.exists() ? (s.data().fcmTokens || []).length + ' token(s), notificationsEnabled=' + s.data().notificationsEnabled : 'no user doc'; }"""))
        scope = pg.evaluate("navigator.serviceWorker.getRegistrations().then(rs => rs.map(r => r.scope))")
        print('service workers:', scope)
        for e in errs[:6]: print('err', e[:200])
        b.close()
finally:
    call('delete', {'idToken': u['idToken']})
    print('test user deleted')
