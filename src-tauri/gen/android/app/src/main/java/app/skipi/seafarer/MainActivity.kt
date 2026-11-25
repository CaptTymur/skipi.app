package app.skipi.seafarer

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import androidx.core.content.FileProvider
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.roundToInt

class MainActivity : TauriActivity() {
  companion object {
    private const val MOTION_MAX_ROWS = 6000
  }

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

  // ---- Motion sensors + keep-awake for plugins (host-runtime 1.2: grants `motion` / `keep_awake`) ----
  //
  // The plugin frame has no sensor access; the host reads the sensors here and the page
  // drains the buffered rows about every 100 ms (commands/motion.rs → plugin-remote-boot.js).
  // One row per accelerometer event: "t_ms,ax,ay,az[,wx,wy,wz]" — specific force with g in
  // m/s² and angular rate in rad/s, Android device axes (flat, screen up → az ≈ +9.81).
  // The gyroscope is sampled-and-held: its latest reading rides on each accelerometer row.
  private val motionLock = Any()
  private val motionRows = StringBuilder()
  private var motionRowCount = 0
  private var motionThread: HandlerThread? = null
  private var motionPeriodUs = 0          // 0 = sensors not wanted
  private var motionRegistered = false
  private var motionHasGyro = false
  private var motionLastRowNs = 0L
  @Volatile private var gyroSeen = false
  @Volatile private var gyroX = 0f
  @Volatile private var gyroY = 0f
  @Volatile private var gyroZ = 0f

  private val motionListener = object : SensorEventListener {
    override fun onSensorChanged(event: SensorEvent) {
      when (event.sensor.type) {
        Sensor.TYPE_GYROSCOPE -> {
          gyroX = event.values[0]; gyroY = event.values[1]; gyroZ = event.values[2]; gyroSeen = true
        }
        Sensor.TYPE_ACCELEROMETER -> synchronized(motionLock) {
          // The system may deliver faster than asked (another client of the same sensor; measured
          // on a Pixel 7: ~118 Hz for a 50 Hz request). Readings closer than 0.6 of the asked
          // period are skipped, so the stream stays near the asked rate (here every 2nd → 59 Hz)
          // and never falls below it. Each row carries its own time; the plugin relies on that.
          val sinceLast = event.timestamp - motionLastRowNs
          if (motionLastRowNs != 0L && sinceLast >= 0 && sinceLast < motionPeriodUs * 600L) return
          motionLastRowNs = event.timestamp
          // The page stopped draining (hidden, busy): keep the newest ~1 minute, drop the rest.
          if (motionRowCount >= MOTION_MAX_ROWS) { motionRows.setLength(0); motionRowCount = 0 }
          motionRows.append(event.timestamp / 1.0e6).append(',')
            .append(event.values[0]).append(',').append(event.values[1]).append(',').append(event.values[2])
          if (gyroSeen) motionRows.append(',').append(gyroX).append(',').append(gyroY).append(',').append(gyroZ)
          motionRows.append('\n')
          motionRowCount++
        }
      }
    }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
  }

  private fun registerMotion(): Boolean {
    if (motionRegistered) return true
    val manager = getSystemService(SENSOR_SERVICE) as? SensorManager ?: return false
    val accel = manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
    val gyro = manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    val thread = HandlerThread("skipi-motion").also { it.start() }
    val handler = Handler(thread.looper)
    if (!manager.registerListener(motionListener, accel, motionPeriodUs, handler)) {
      thread.quitSafely()
      return false
    }
    motionHasGyro = gyro != null && manager.registerListener(motionListener, gyro, motionPeriodUs, handler)
    motionThread = thread
    motionRegistered = true
    return true
  }

  private fun unregisterMotion() {
    if (!motionRegistered) return
    try { (getSystemService(SENSOR_SERVICE) as? SensorManager)?.unregisterListener(motionListener) } catch (e: Exception) {}
    motionThread?.quitSafely()
    motionThread = null
    motionRegistered = false
    gyroSeen = false
    motionLastRowNs = 0L
  }

  /** Returns "OK <rateHz> <gyro 0|1>" or "ERROR:<reason>". */
  fun startSkipiMotion(rateHz: Int): String {
    return try {
      val rate = rateHz.coerceIn(1, 100)
      unregisterMotion()
      synchronized(motionLock) { motionRows.setLength(0); motionRowCount = 0 }
      motionPeriodUs = 1_000_000 / rate
      if (!registerMotion()) {
        motionPeriodUs = 0
        return "ERROR:no-sensors"
      }
      "OK $rate ${if (motionHasGyro) 1 else 0}"
    } catch (e: Exception) {
      motionPeriodUs = 0
      "ERROR:" + (e.localizedMessage ?: e.toString())
    }
  }

  /** Buffered rows since the previous call, one per line; empty when there is nothing new. */
  fun drainSkipiMotion(): String {
    synchronized(motionLock) {
      if (motionRowCount == 0) return ""
      val out = motionRows.toString()
      motionRows.setLength(0)
      motionRowCount = 0
      return out
    }
  }

  fun stopSkipiMotion() {
    motionPeriodUs = 0
    unregisterMotion()
    synchronized(motionLock) { motionRows.setLength(0); motionRowCount = 0 }
  }

  fun setSkipiKeepAwake(on: Boolean) {
    runOnUiThread {
      try {
        if (on) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      } catch (e: Exception) {}
    }
  }

  // Sensors run only while the app is in front: a plugin left open must not keep them on
  // in the background. The plugin sees the pause as a gap in the sample times.
  override fun onPause() {
    unregisterMotion()
    super.onPause()
  }

  override fun onResume() {
    super.onResume()
    if (motionPeriodUs > 0) try { registerMotion() } catch (e: Exception) {}
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
      lower.endsWith(".doc") -> "application/msword"
      lower.endsWith(".docx") -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
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
