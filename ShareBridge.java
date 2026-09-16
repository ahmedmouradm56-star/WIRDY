package com.app.wirdy;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * The missing link. Without this, an image physically cannot leave the WebView:
 * navigator.share and ClipboardItem do not exist there, and a blob: download is
 * dropped on the floor. JS hands the PNG over in 384 KB base64 slices (one call
 * with a 6 MB string spikes memory and can ANR on low-end phones), then asks for
 * a share sheet or a save.
 */
public class ShareBridge {

    private final Activity activity;
    private ByteArrayOutputStream buffer;

    public ShareBridge(Activity activity) {
        this.activity = activity;
    }

    private void toast(final String msg) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private String safeName(String name) {
        if (name == null) name = "timetable.png";
        String clean = name.replaceAll("[^A-Za-z0-9._-]", "_");
        if (clean.length() > 100) clean = clean.substring(0, 100);
        if (clean.isEmpty()) clean = "timetable";
        return clean.toLowerCase().endsWith(".png") ? clean : clean + ".png";
    }

    // ---- chunked intake -------------------------------------------------

    @JavascriptInterface
    public void startImage() {
        buffer = new ByteArrayOutputStream(1 << 21);
    }

    @JavascriptInterface
    public void addChunk(String part) {
        if (buffer == null) return;
        try {
            buffer.write(Base64.decode(part, Base64.DEFAULT));
        } catch (Exception e) {
            buffer = null;
        }
    }

    private byte[] drain() {
        if (buffer == null) return null;
        byte[] out = buffer.toByteArray();
        buffer = null;
        return out.length == 0 ? null : out;
    }

    // ---- outputs --------------------------------------------------------

    /**
     * Fires ACTION_SEND carrying a real content:// stream, so WhatsApp, Gmail
     * and Telegram receive the picture rather than a line of text.
     */
    @JavascriptInterface
    public boolean shareImage(String fileName, String text, String targetPackage) {
        final byte[] bytes = drain();
        if (bytes == null) { toast("Image was empty"); return false; }
        try {
            File dir = new File(activity.getCacheDir(), "shared_images");
            dir.mkdirs();
            long cutoff = System.currentTimeMillis() - 3600000L;
            File[] old = dir.listFiles();
            if (old != null) {
                for (File f : old) if (f.lastModified() < cutoff) f.delete();
            }

            File file = new File(dir, safeName(fileName));
            FileOutputStream fos = new FileOutputStream(file);
            try { fos.write(bytes); } finally { fos.close(); }

            Uri uri = FileProvider.getUriForFile(
                    activity, activity.getPackageName() + ".fileprovider", file);

            final Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("image/png");
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.trim().isEmpty()) {
                send.putExtra(Intent.EXTRA_TEXT, text);
            }
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            if (targetPackage != null && !targetPackage.trim().isEmpty()
                    && send.resolveActivity(activity.getPackageManager()) != null) {
                send.setPackage(targetPackage);
            }

            activity.runOnUiThread(new Runnable() {
                @Override public void run() {
                    activity.startActivity(Intent.createChooser(send, null));
                }
            });
            return true;
        } catch (Exception e) {
            toast("Share failed");
            return false;
        }
    }

    /** Saves to Pictures/Wirdy. Needs no permission on API 29+. */
    @JavascriptInterface
    public boolean saveImage(String fileName) {
        byte[] bytes = drain();
        if (bytes == null) { toast("Image was empty"); return false; }
        String name = safeName(fileName);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues cv = new ContentValues();
                cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                cv.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                cv.put(MediaStore.Images.Media.RELATIVE_PATH,
                        Environment.DIRECTORY_PICTURES + "/Wirdy");
                cv.put(MediaStore.Images.Media.IS_PENDING, 1);

                ContentResolver cr = activity.getContentResolver();
                Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                if (uri == null) { toast("Save failed"); return false; }

                OutputStream os = cr.openOutputStream(uri);
                if (os == null) { toast("Save failed"); return false; }
                try { os.write(bytes); } finally { os.close(); }

                cv.clear();
                cv.put(MediaStore.Images.Media.IS_PENDING, 0);
                cr.update(uri, cv, null, null);
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_PICTURES), "Wirdy");
                dir.mkdirs();
                File file = new File(dir, name);
                FileOutputStream fos = new FileOutputStream(file);
                try { fos.write(bytes); } finally { fos.close(); }
                activity.sendBroadcast(new Intent(
                        Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(file)));
            }
            toast("Saved to Pictures/Wirdy");
            return true;
        } catch (Exception e) {
            toast("Save failed");
            return false;
        }
    }

    /** Plain text hand-off, kept so the page always has a last resort. */
    @JavascriptInterface
    public void shareText(final String text) {
        activity.runOnUiThread(new Runnable() {
            @Override public void run() {
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                activity.startActivity(Intent.createChooser(i, null));
            }
        });
    }

    @JavascriptInterface
    public boolean isAvailable() { return true; }
}
