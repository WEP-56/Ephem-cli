package com.example.ephem_flutter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

class EphemKeepaliveService : Service() {
    override fun onCreate() {
        super.onCreate()
        ensureChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val roomCode = intent?.getStringExtra(EXTRA_ROOM_CODE).orEmpty()
        val notification = buildNotification(roomCode)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Ephem chat connection",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the current Ephem chat connected while the app is in the background."
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(roomCode: String): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val title = "Ephem 正在保持聊天连接"
        val text = if (roomCode.isBlank()) "后台连接保活中" else "房间 $roomCode"
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setShowWhen(false)
            .build()
    }

    companion object {
        const val EXTRA_ROOM_CODE = "roomCode"
        private const val CHANNEL_ID = "ephem_chat_keepalive"
        private const val NOTIFICATION_ID = 33030
    }
}
