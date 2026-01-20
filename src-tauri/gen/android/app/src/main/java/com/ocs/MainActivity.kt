package com.ocs

import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()

    // Keep a best-effort bundled Stockfish available for the Rust backend.
    //
    // Preferred: execute from nativeLibraryDir (`libstockfish.so`) because some devices block exec
    // from app data even with chmod (noexec/SELinux policy).
    //
    // Fallback: copy from APK assets to filesDir/engines/stockfish.
    Thread {
      ensureBundledStockfishInstalled()
    }.start()

    super.onCreate(savedInstanceState)
  }

  private fun ensureBundledStockfishInstalled() {
    try {
      // Prefer the bundled binary shipped as a native lib (.so) in jniLibs.
      // This avoids noexec/policy issues on some devices.
      val nativeLibDirPath = applicationInfo.nativeLibraryDir
      if (nativeLibDirPath != null) {
        val nativeLibStockfish = File(nativeLibDirPath, "libstockfish.so")
        if (nativeLibStockfish.exists() && nativeLibStockfish.isFile && nativeLibStockfish.length() > 0) {
          Log.i("OCS", "Bundled Stockfish available in nativeLibraryDir: ${nativeLibStockfish.absolutePath}")
          return
        }
      }

      val enginesDir = File(filesDir, "engines")
      val stockfishFile = File(enginesDir, "stockfish")

      // If already installed, do nothing.
      if (stockfishFile.exists() && stockfishFile.isFile && stockfishFile.length() > 0) {
        Log.i("OCS", "Bundled Stockfish already installed at: ${stockfishFile.absolutePath}")
        return
      }

      enginesDir.mkdirs()

      // Copy from assets/engines/stockfish
      assets.open("engines/stockfish").use { input ->
        FileOutputStream(stockfishFile).use { output ->
          input.copyTo(output)
        }
      }

      // Set permissions (best-effort)
      enginesDir.setReadable(true, false)
      enginesDir.setExecutable(true, false)
      enginesDir.setWritable(true, true)

      stockfishFile.setReadable(true, false)
      stockfishFile.setExecutable(true, false)
      stockfishFile.setWritable(true, true)

      Log.i("OCS", "Installed bundled Stockfish at: ${stockfishFile.absolutePath} (size=${stockfishFile.length()})")
    } catch (e: Exception) {
      Log.e("OCS", "Failed to install bundled Stockfish from assets", e)
    }
  }
}
