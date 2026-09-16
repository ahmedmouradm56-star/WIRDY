# Wirdy — study timetable, APK build

Ready to compile. No Android Studio, no SDK install, no local setup.
GitHub builds it and hands you the `.apk`.

---

## Get the APK in ~4 minutes

**1 — New repo** · <https://github.com/new> · any name · **Private** is fine · Create.

**2 — Upload** · on the empty repo page click **uploading an existing file** ·
drag in **everything from this folder** (keep the folder structure — easiest is
to drag the unzipped folder's *contents*, including the hidden `.github`
folder) · **Commit changes**.

> If drag-and-drop skips `.github`, create it by hand: **Add file → Create new
> file**, type `.github/workflows/build.yml` as the name, paste in the contents
> of that file, commit. This one file is what does the building.

**3 — Watch it build** · **Actions** tab → the run starts by itself → wait for
the green tick (first run ≈ 3 min; later runs ≈ 1 min).

**4 — Download** · click the finished run → **Artifacts** at the bottom →
**Wirdy-APK** → unzip → `app-debug.apk`.

**5 — Install** · move it to your phone · tap it · allow *Install unknown apps*
when prompted.

If the run goes red, open the failed step and send me the log — it will name the
exact line.

---

## What was actually broken

Your old APK shared a line of text instead of the table because the image had no
way out of the WebView. Verified against the binary, not guessed:

| Checked in `classes.dex` | Found |
|---|---|
| `addJavascriptInterface` | **0** |
| `setDownloadListener` | **0** |
| `FileProvider` authority in manifest | **0** |

So at runtime:

```
navigator.share        -> undefined   (browser-only API, absent in WebView)
ClipboardItem write    -> undefined   (same)
<a download> on blob:  -> ignored     (no DownloadListener)
window.AndroidDownloader -> never existed
                    |
                    v
   whatsapp://send?text=...  <- the only surviving path = TEXT ONLY
```

On top of that, `html2canvas` was pulled from `cdnjs.cloudflare.com`. Offline,
`typeof html2canvas !== 'function'`, so the picture was never even built.

## What this build changes

**1. Capture works offline.** The CDN `<script>` is gone. In its place,
`tools/wirdy-offline.js` provides a drop-in `window.html2canvas(el, opts)` backed
by a purpose-built Canvas2D renderer that measures the real DOM — boxes, borders,
inline SVG icons, RTL Arabic text. Every existing call site in your HTML is
untouched.

**2. Text is contrast-checked.** Each cell's text colour is tested against its
actual background. At or above 4.5:1 (WCAG AA) your colour is kept exactly.
Below it, the text flips to near-black or white, whichever reads better.
Text too tall for its cell shrinks to fit instead of being clipped, so nothing
comes out cut off.

Measured:

```
#34544C on #F4F7F6     7.74 -> 7.74    kept (already legible)
light grey on white    1.67 -> 18.88   corrected
white on pale mint     1.12 -> 16.80   corrected
```

**3. The whole table image is shared.** `ShareBridge.java` is a
`@JavascriptInterface` exposed as `WirdyBridge`. JS pushes the PNG across in
384 KB base64 slices (a single 6 MB string spikes memory and can ANR on cheap
phones), then the native side writes it to cache, wraps it in a `FileProvider`
`content://` URI and fires `ACTION_SEND` with `EXTRA_STREAM`. WhatsApp, Gmail
and Telegram receive the **picture**.

**4. Download works.** `<a download>` clicks on `blob:` URLs are caught in the
capture phase and routed to `MediaStore` → `Pictures/Wirdy`. No permission
needed on Android 10+.

The page's own logic was not rewritten. `navigator.share` / `navigator.canShare`
are polyfilled onto the bridge, so `canShareFile()`, `sharePicture()`,
`shareImage()`, `shareWhatsApp()` and `downloadImg()` all keep working as
written. In a normal browser the polyfill stands down and the real Web Share API
is used.

---

## Notes

- **Signing.** Debug-signed, which installs fine by sideload. For Play upload,
  generate a key and point `signingConfigs` in `app/build.gradle` at it.
- **Package** is `com.app.wirdy`. It will install alongside / over your existing
  Wirdy only if that one shares this package *and* signature — it does not, so
  uninstall the old one first.
- **minSdk 26** (Android 8.0+).
- **Updating the HTML later:** drop the new file in and run
  `python3 tools/patch.py` — it re-strips the CDN tag and re-injects the
  renderer. Or edit `app/src/main/assets/index.html` directly.
- One thing I could not do here: run it. This environment has no emulator, so
  the build is unverified on a device. If anything misbehaves, tell me what you
  see and I will fix it.
