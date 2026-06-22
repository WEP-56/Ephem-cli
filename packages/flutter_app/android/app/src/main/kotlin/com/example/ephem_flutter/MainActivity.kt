package com.example.ephem_flutter

import android.content.Intent
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "ephem/background")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        val roomCode = call.argument<String>("roomCode") ?: ""
                        val intent = Intent(this, EphemKeepaliveService::class.java)
                            .putExtra(EphemKeepaliveService.EXTRA_ROOM_CODE, roomCode)
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            startForegroundService(intent)
                        } else {
                            startService(intent)
                        }
                        result.success(null)
                    }
                    "stop" -> {
                        stopService(Intent(this, EphemKeepaliveService::class.java))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
