package app.skipi.seafarer

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.os.Bundle
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
