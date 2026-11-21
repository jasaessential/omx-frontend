"""Load site pages from the local server (localhost:5500, local Workers on 8798/8799)
in headless Chromium; report console errors, failed requests and the /db calls.

  D:/Studio/claude-seo/.venv/Scripts/python.exe cf-migrate/smoke-pages.py [page ...]
"""
import os, sys, json
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', r'D:\Studio\claude-seo\ms-playwright')
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5500/'
PAGES = sys.argv[1:] or [
    'index.html', 'login.html', 'categories.html?cat=stationary', 'cart.html', 'xerox-order.html',
    'orders.html', 'profile.html', 'wallet.html', 'support.html', 'custom-poster.html',
    'wall-builder.html', 'item-details.html?id=none', 'refer.html', 'product-request.html',
]
SHOTS = os.path.join(os.path.dirname(__file__), 'shots')
os.makedirs(SHOTS, exist_ok=True)

IGNORE = ('favicon', 'googletagmanager', 'google-analytics', 'firebaseinstallations', 'fonts.g')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 412, 'height': 900})
    bad = 0
    for page_name in PAGES:
        pg = ctx.new_page()
        errors, failed, dbcalls = [], [], []
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        pg.on('requestfailed', lambda r: failed.append(f'{r.url} {r.failure}') if not any(i in r.url for i in IGNORE) else None)
        def on_resp(r):
            if '/db/' in r.url or ':8799/api' in r.url or ':8798/api' in r.url:
                dbcalls.append(f'{r.status} {r.request.method} {r.url.split("//")[1].split("/", 1)[1][:60]}')
            elif r.status >= 400 and not any(i in r.url for i in IGNORE):
                failed.append(f'{r.status} {r.url}')
        pg.on('response', on_resp)
        try:
            pg.goto(BASE + page_name, wait_until='networkidle', timeout=30000)
        except Exception as e:
            errors.append(f'GOTO {e}')
        pg.wait_for_timeout(2500)
        pg.screenshot(path=os.path.join(SHOTS, page_name.split('?')[0].replace('.html', '') + '.png'))
        firestore_sdk = pg.evaluate("performance.getEntriesByType('resource').some(e => e.name.includes('firebase-firestore'))")
        ok = not errors and not failed and not firestore_sdk
        bad += 0 if ok else 1
        print(('ok  ' if ok else 'CHECK'), page_name)
        for c in dbcalls[:12]: print('      api', c)
        if firestore_sdk: print('      !! real Firestore SDK still loaded')
        for e in errors[:8]: print('      err', e[:220])
        for f in failed[:8]: print('      req', f[:220])
        pg.close()
    b.close()
    print(f'\n{len(PAGES) - bad}/{len(PAGES)} clean')
