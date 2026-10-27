"""End-to-end UI test in DEMO mode with REAL silk photos. Run: python3 tests/e2e/e2e.py"""
import subprocess, time, sys, os, random
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PH = os.path.join(ROOT, 'tests', 'fixtures', 'photos')
OUT = os.environ.get('E2E_OUT', '/tmp/e2e'); os.makedirs(OUT, exist_ok=True)

def other_design(seed, path):          # an invented, clearly different design
    r = random.Random(seed); im = Image.new('RGB', (720, 1280), (r.randint(20, 200), r.randint(20, 200), r.randint(20, 200))); d = ImageDraw.Draw(im)
    acc = (r.randint(120, 255), r.randint(120, 255), r.randint(120, 255))
    for _ in range(45):
        x, y, s = r.randint(0, 700), r.randint(300, 1250), r.randint(20, 160)
        if r.random() < .5: d.ellipse([x, y, x + s, y + int(s * r.uniform(.4, 1.8))], outline=acc, width=r.randint(2, 7))
        else: d.line([x, y, x + r.randint(-s, s) * 2, y + s], fill=acc, width=r.randint(2, 8))
    im.save(path)
other_design(77, f'{OUT}/other.jpg')

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8099', '--bind', '127.0.0.1'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2); results = []
def check(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name + (' ' + str(extra) if extra and not cond else ''))

try:
    with sync_playwright() as p:
        br = p.chromium.launch(); ctx = br.new_context(viewport={'width': 1280, 'height': 1000}); page = ctx.new_page()
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('**/fonts.g*', lambda r: r.abort())
        page.goto('http://127.0.0.1:8099/index.html'); page.wait_for_selector('#login')
        page.fill('#in-staff', 'Meena'); page.click('button[type=submit]'); page.wait_for_selector('#supplier')

        def upload(img, supplier='Test Supplier'):
            page.fill('#supplier', supplier); page.set_input_files('#photo', img)
            page.wait_for_function("() => document.querySelector('[data-act=submit]') && !document.querySelector('.skeleton')", timeout=60000)
            page.wait_for_timeout(300)
        # 1. first photo: new design
        upload(f'{PH}/design-yellow.jpg')
        check('first photo is a new design', 'new design' in page.locator('.result').inner_text().lower(), page.locator('.result').inner_text()[:80])
        page.click('[data-act=submit]'); page.wait_for_selector('#dn')
        check('yellow gets MPS-TSX-0001', page.locator('#dn').inner_text() == 'MPS-TSX-0001', page.locator('#dn').inner_text())
        # 2. SAME photo again
        page.click('[data-act=again]'); upload(f'{PH}/design-yellow.jpg')
        txt = page.locator('.result').inner_text()
        check('same photo: "We have seen this before" + number', 'existing design' in txt.lower() and 'MPS-TSX-0001' in txt, txt[:150])
        page.screenshot(path=f'{OUT}/e1_same.png')
        page.click('[data-act=submit]'); page.wait_for_selector('#dn')
        check('same photo returns existing number', page.locator('#dn').inner_text() == 'MPS-TSX-0001')
        # 3. SAME DESIGN, DIFFERENT COLOUR (blue)
        page.click('[data-act=again]'); upload(f'{PH}/design-blue.jpg')
        txt = page.locator('.result').inner_text()
        check('blue colourway: yellow design offered as a candidate', 'MPS-TSX-0001' in txt, txt[:200])
        page.screenshot(path=f'{OUT}/e2_colourway.png')
        page.click('[data-act=pick][data-no=MPS-TSX-0001]'); page.click('[data-act=submit]'); page.wait_for_selector('#dn')
        check('colourway confirmed -> same number, no new design', page.locator('#dn').inner_text() == 'MPS-TSX-0001')
        # 4. a different design must not be mistaken
        page.click('[data-act=again]'); upload(f'{OUT}/other.jpg')
        txt = page.locator('.result').inner_text()
        check('unrelated design is treated as new', 'new design' in txt.lower() and 'existing design' not in txt.lower(), txt[:150])
        page.click('[data-act=submit]'); page.wait_for_selector('#dn')
        check('unrelated design gets MPS-TSX-0002', page.locator('#dn').inner_text() == 'MPS-TSX-0002', page.locator('#dn').inner_text())
        # persistence + other pages
        page.goto('http://127.0.0.1:8099/index.html#catalogue'); page.reload(); page.wait_for_selector('.grid')
        check('catalogue shows 2 designs after reload', page.locator('.card').count() == 2, page.locator('.card').count())
        page.goto('http://127.0.0.1:8099/index.html#status'); page.reload(); page.wait_for_selector('.kpis')
        check('status page lists 2 active', page.locator('.kpi b').nth(1).inner_text() == '2')
        page.goto('http://127.0.0.1:8099/index.html#report'); page.reload(); page.wait_for_selector('#paper')
        check('report renders', 'Monthly review' in page.locator('#paper').inner_text())
        # same photo under another supplier is independent
        page.goto('http://127.0.0.1:8099/index.html#register'); page.reload(); page.wait_for_selector('#supplier')
        upload(f'{PH}/design-yellow.jpg', 'Kanchi Weaves')
        check('other supplier does not see Test Supplier designs', 'new design' in page.locator('.result').inner_text().lower())
        check('no JS errors', not errors, errors)
        br.close()
finally:
    srv.terminate()
failed = [n for n, ok in results if not ok]
print(f'\n{len(results)-len(failed)}/{len(results)} passed'); sys.exit(1 if failed else 0)
