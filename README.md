# MPS Silks — Design Registry

Staff enter a **supplier name** and take a **photo** of the product. The registry compares the photo with that supplier's earlier photos:

- **Recognised** → shows the existing design number (e.g. `MPS-SLS-0001`) and records a sighting.
- **Not recognised** → creates the next design number for that supplier and stores it.

Everything is stored in **Google Sheets** (via Google Apps Script) and photos in **Google Drive**. The website is static and hosted free on **GitHub Pages**. A **monthly PDF report** shows active / inactive designs and how many days each has been inactive.

Cost: ₹0. No paid API, no server.

```
Browser (GitHub Pages)  ──►  Apps Script web app  ──►  Google Sheet (Designs, Sightings, Settings)
  photo → fingerprint                                   + Drive folder "MPS Design Photos"
```

## How a photo is recognised (please read)

Two checks, then **a person always confirms**. Nothing here is 100% accurate, and the app never pretends it is.

1. **Built-in pattern check (free, private, always on).** Runs in the staff member's browser. It ignores colour and compares the shapes of the motifs with the same supplier's earlier photos, tolerating a shifted, closer or retaken photo. It gives each earlier design a verdict: *strong match*, *possible*, or nothing. The same design in another colour usually lands on **possible**, not strong, so it is offered to staff as a candidate to confirm.
2. **Gemini second opinion (optional, free tier).** If you add a Gemini API key (below), the server also sends the new photo and up to 5 of the supplier's closest earlier photos to Gemini, which answers "same design or not, ignoring colour" with a confidence and a short reason. This catches colour variants the built-in check misses. If Gemini is off, over its free limit or unreachable, the app silently carries on with check 1.

Staff then choose the right design or *None of these*. Registering a practically identical photo as new is refused by the server.

### Gemini setup (optional)
1. Create a free key at Google AI Studio (aistudio.google.com).
2. Apps Script → **Project Settings → Script properties → Add**: `GEMINI_API_KEY` = your key. (Optional: `GEMINI_MODEL`, default `gemini-3.8-flash`; use another free Flash model if Google retires it.)
3. Deploy → Manage deployments → Edit → **New version**.
4. Remove the property to switch Gemini off.

**Privacy:** photos are sent to Google for this check. On Google's **free tier**, Google states that submitted content may be used to improve its products. Get MPS's agreement before enabling it for their product photos; the paid tier does not do this.

## Setup (about 15 minutes)

### 1. Backend: Google Sheet + Apps Script
*(Upgrading from an earlier version? Paste the new `Code.gs` and `Core.gs`, run `setup` again to create the `Signatures` sheet, delete your old test rows in Designs/Sightings and the test photos in Drive, then Deploy → Manage deployments → Edit → New version. Designs registered with the older version cannot be matched by the new check.)*

1. Create a new Google Sheet, e.g. "MPS Design Registry".
2. **Extensions → Apps Script**.
3. Paste `apps_script/Code.gs` into `Code.gs`. Add a second file named `Core` (**+ → Script**) and paste `apps_script/Core.gs` into it.
4. Select the function `setup` and click **Run**. Approve the permissions (Sheets and Drive). Open **Execution log**: it prints your staff **PIN**. (You can change it in **Project Settings → Script properties → `APP_PIN`**.)
5. **Deploy → New deployment → Web app**: *Execute as* **Me**, *Who has access* **Anyone**. Copy the **/exec URL**.
   - After any later change to the script, use **Deploy → Manage deployments → Edit → New version**.

### 2. Frontend: configure and publish
1. Put the URL in `js/config.js` (`API_URL`).
2. Logos are already in `assets/` (see `assets/README.md`).
3. Create a GitHub repository and push this folder to the `main` branch.
4. **Settings → Pages → Source: GitHub Actions.** The included workflow tests and deploys the site on every push.
5. Staff open the Pages URL on their phone, enter their name and the PIN. On a phone they can use **Add to Home Screen**.

Leave `API_URL` empty to try the app in **demo mode** (data stays in that browser only).

## Using it
- **Register** – supplier, photo, confirm. A design number appears (copy button).
- **Catalogue** – all designs with photos, search and filters. Click one for its history.
- **Status** – active / inactive counts, days since last activity, CSV download.
- **Report** – pick a month → **Download PDF** (uses the browser's *Save as PDF*; the page has a print layout for A4).
- **Settings** – the inactive threshold (default 90 days).

**Active / inactive rule:** a design's activity is its registration or any later "seen again" sighting. If more than *N* days (default 90) pass without activity it is *Inactive*, and **days inactive = days since that last activity**. The monthly report is evaluated at the end of the chosen month.

## Tests
```
npm test                        # 27 tests: matching (real photos), numbering, status, report, backend + Gemini (Sheets/Drive/Gemini mocked)
python3 tests/e2e/e2e.py        # 13 UI checks in headless Chromium, demo mode, using the two real photos (needs playwright + pillow)
```

## What has and hasn't been verified
| Verified | Not verified |
|---|---|
| Matching on **two real photos** (same design, yellow and blue): the blue photo offers the yellow design as *possible*; the same photo, a retake, a shifted and a closer photo come out *strong*; 12 invented unrelated designs are not offered | **Accuracy on a real catalogue.** Only one real design pair was available. Different designs that share similar border motifs may be offered as *possible* (staff then say no) or, rarely, a real colour variant may be missed. Pilot with 30+ real products |
| Backend rules with Sheets, Drive and Gemini **mocked**: PIN, validation, duplicate protection, idempotent retries, signatures, Gemini request/response handling, errors | **Real Gemini calls**: request format follows Google's current docs, but no real key was available. Test with your key and a known pair |
| Full UI flow in a real browser (demo mode) incl. PDF print | Deployment to your Google account, CORS from GitHub Pages, camera on real phones |

Tuning: thresholds are in `DEFAULTS` at the top of `js/core.js` (`patternSame`, `patternMaybe`, `globalMaybe`). After changing it run `npm test` (this also regenerates `apps_script/Core.gs`) and paste `Core.gs` into Apps Script again.

## Known limits
- **Security is light by design:** one shared PIN. Anyone with the PIN can read and register. Photos are in a Drive folder shared as *anyone with the link can view* so the app can display them. Don't use it for confidential data.
- The PIN is sent in the request URL for reads (visible in Apps Script logs/browser history).
- Google Sheets/Apps Script quotas apply (fine for a small team; thousands of designs are OK, tens of thousands will get slow).
- No edit/delete of designs in the app: correct or remove rows directly in the Sheet. Deleting a design row removes it from reports.
- Photo analysis needs a reasonably flat, well-lit photo filling the frame. Matching runs on the staff member's device and takes a few seconds on older phones.
- Each design stores a ~30 KB pattern signature in the `Signatures` sheet (used for matching). Do not edit it by hand.

## Files
```
index.html, css/style.css          interface
js/core.js                         matching, numbering, status, report logic (shared with backend)
js/api.js                          Apps Script client + demo backend
js/app.js                          screens
apps_script/Code.gs, Core.gs       backend (Core.gs is generated: node tools/build-gs.js)
tests/                             unit + end-to-end tests
.github/workflows/pages.yml        free hosting
```
