package app.skipi.seafarer

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.WindowInsets
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    installImeInsetPadding()
  }

  /**
   * Keyboard inset (defect 308, owner 06.09: "клавиатура закрывала область ввода").
   *
   * Measured, not assumed: with the Android default softInputMode the window runs
   * adjust=pan, the WebView is never resized, and the page sees nothing at all —
   * with the keyboard up the live WebView reported innerHeight=842,
   * visualViewport.height=842.29, offsetTop=0 and fired zero resize events, and
   * navigator.virtualKeyboard.boundingRect stayed {0,0,0,0}. So the composer
   * cannot be lifted from dist/: the window itself has to shrink.
   *
   * Two disjoint paths, one per API range, so they can never double-apply:
   *  - API <= 34: android:windowSoftInputMode="adjustResize" in the manifest
   *    resizes the window and this listener deliberately stays out of the way.
   *  - API >= 35 (Android 15+): edge-to-edge is enforced and adjustResize is
   *    ignored, so the ime() inset has to be turned into padding by hand.
   *
   * The padding is the REAL overlap between the content view and the keyboard,
   * not the raw inset: if the platform did resize the window after all, the
   * overlap is already zero and nothing extra is applied.
   */
  private fun installImeInsetPadding() {
    if (Build.VERSION.SDK_INT < 35) return
    try {
      val content = findViewById<View>(android.R.id.content) ?: return
      content.setOnApplyWindowInsetsListener { view, insets ->
        try {
          val ime = insets.getInsets(WindowInsets.Type.ime()).bottom
          var pad = 0
          if (ime > 0) {
            val location = IntArray(2)
            view.getLocationOnScreen(location)
            val screenBottom = windowManager.currentWindowMetrics.bounds.bottom
            pad = max(0, (location[1] + view.height) - (screenBottom - ime))
          }
          if (view.paddingBottom != pad) {
            view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, pad)
          }
        } catch (e: Exception) {
          // A keyboard that cannot be measured must never take the app down.
        }
        insets
      }
    } catch (e: Exception) {
      // Same here: the fix is a nicety, launching is not.
    }
  }

  fun openSkipiFile(path: String, mime: String): String? {
    val file = File(path)
    if (!file.exists()) return "File not found: $path"

    return try {
      val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime.ifBlank { "*/*" })
        clipData = ClipData.newUri(contentResolver, file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(Intent.createChooser(intent, "Open file"))
      null
    } catch (e: ActivityNotFoundException) {
      "No app installed to open this file. Install a PDF viewer and try again."
    } catch (e: Exception) {
      e.localizedMessage ?: e.toString()
    }
  }

  fun openSkipiUrl(url: String): String? {
    return try {
      val uri = android.net.Uri.parse(url)
      val intent = Intent(Intent.ACTION_VIEW, uri).apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      startActivity(Intent.createChooser(intent, "Open link"))
      null
    } catch (e: ActivityNotFoundException) {
      "No app installed to open this link."
    } catch (e: Exception) {
      e.localizedMessage ?: e.toString()
    }
  }

  private fun guessMime(path: String): String {
    val lower = path.lowercase()
    return when {
      lower.endsWith(".pdf") -> "application/pdf"
      lower.endsWith(".zip") -> "application/zip"
      lower.endsWith(".png") -> "image/png"
      lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
      lower.endsWith(".txt") -> "text/plain"
      else -> "*/*"
    }
  }

  fun shareSkipiDispatch(
    subject: String,
    body: String,
    recipientsText: String,
    pathsText: String,
    mode: String
  ): String? {
    val emailMode = mode == "email"
    val recipients = recipientsText
      .split('\n')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .toTypedArray()
    val files = pathsText
      .split('\n')
      .map { it.trim() }
      .filter { it.isNotEmpty() }
      .map { File(it) }

    return try {
      val uris = files.map { file ->
        if (!file.exists()) return "File not found: ${file.absolutePath}"
        FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
      }

      val intent = if (uris.size > 1) {
        Intent(Intent.ACTION_SEND_MULTIPLE).apply {
          putParcelableArrayListExtra(Intent.EXTRA_STREAM, ArrayList(uris))
        }
      } else {
        Intent(Intent.ACTION_SEND).apply {
          if (uris.size == 1) putExtra(Intent.EXTRA_STREAM, uris[0])
        }
      }

      intent.apply {
        type = when {
          uris.isEmpty() -> "text/plain"
          uris.size == 1 -> guessMime(files[0].absolutePath)
          else -> "*/*"
        }
        if (emailMode && recipients.isNotEmpty()) putExtra(Intent.EXTRA_EMAIL, recipients)
        putExtra(Intent.EXTRA_SUBJECT, subject)
        putExtra(Intent.EXTRA_TEXT, body)
        putExtra(Intent.EXTRA_TITLE, subject)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (uris.isNotEmpty()) {
          clipData = ClipData.newUri(contentResolver, "Skipi attachment", uris[0]).apply {
            for (idx in 1 until uris.size) {
              addItem(ClipData.Item(uris[idx]))
            }
          }
        }
      }

      startActivity(Intent.createChooser(intent, if (emailMode) "Email from Skipi" else "Share from Skipi"))
      null
    } catch (e: ActivityNotFoundException) {
      "No app installed to share this dispatch."
    } catch (e: Exception) {
      e.localizedMessage ?: e.toString()
    }
  }

  fun renderSkipiPdfPage(path: String, maxWidth: Int): String {
    val file = File(path)
    if (!file.exists()) return "ERROR:File not found: $path"

    var descriptor: ParcelFileDescriptor? = null
    var renderer: PdfRenderer? = null
    var page: PdfRenderer.Page? = null
    var bitmap: Bitmap? = null

    return try {
      descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
      renderer = PdfRenderer(descriptor)
      if (renderer.pageCount < 1) return "ERROR:PDF has no pages"

      page = renderer.openPage(0)
      val targetWidth = max(320, maxWidth)
      val scale = targetWidth.toFloat() / page.width.toFloat()
      val targetHeight = max(1, (page.height * scale).roundToInt())

      bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
      bitmap.eraseColor(Color.WHITE)

      val matrix = Matrix().apply {
        postScale(scale, scale)
      }
      page.render(bitmap, null, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)

      val outDir = File(cacheDir, "skipi-preview")
      outDir.mkdirs()
      val outFile = File(outDir, "pdf-preview-${file.nameWithoutExtension}.png")
      FileOutputStream(outFile).use { stream ->
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
      }
      outFile.absolutePath
    } catch (e: Exception) {
      "ERROR:" + (e.localizedMessage ?: e.toString())
    } finally {
      bitmap?.recycle()
      page?.close()
      renderer?.close()
      descriptor?.close()
    }
  }
}
