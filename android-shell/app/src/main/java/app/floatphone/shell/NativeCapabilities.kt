package app.floatphone.shell

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.OutputStream
import java.util.UUID

/** Origin-scoped, main-frame-only capabilities. No file paths are accepted from JS. */
class NativeCapabilities(private val activity: AppCompatActivity) {
    private var pendingSave: Pair<String, JavaScriptReplyProxy>? = null
    private var saveCanceled = false
    private var permissionReply: Pair<String, JavaScriptReplyProxy>? = null
    private var output: OutputStream? = null
    private var outputUri: Uri? = null
    private var token: String? = null
    private var expected = 0L
    private var written = 0L
    private var notificationId = 1000
    private val picker = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val pending = pendingSave
        pendingSave = null
        if (pending != null && !saveCanceled) {
            val uri = if (result.resultCode == android.app.Activity.RESULT_OK) result.data?.data else null
            if (uri == null) reply(pending, error = "已取消保存")
            else try {
                outputUri = uri
                output = activity.contentResolver.openOutputStream(uri, "wt") ?: error("无法打开目标文件")
                token = UUID.randomUUID().toString()
                written = 0
                reply(pending, token)
            } catch (e: Exception) { abort(); reply(pending, error = e.message ?: "无法保存") }
        } else if (result.resultCode == android.app.Activity.RESULT_OK) {
            result.data?.data?.let { runCatching { android.provider.DocumentsContract.deleteDocument(activity.contentResolver, it) } }
        }
    }
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        permissionReply?.let { reply(it, notificationsEnabled()) }
        permissionReply = null
        if (notificationsEnabled()) PushService.start(activity)
    }

    private fun notificationsEnabled() = NotificationManagerCompat.from(activity).areNotificationsEnabled()
    private fun reply(target: Pair<String, JavaScriptReplyProxy>, value: Any? = null, error: String? = null) {
        val json = JSONObject().put("id", target.first).put("value", value ?: JSONObject.NULL)
        if (error != null) json.put("error", error)
        runCatching { target.second.postMessage(json.toString()) }
    }

    fun install(view: WebView) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val site = Uri.parse(MainActivity.SITE_URL)
        val origin = "${site.scheme}://${site.encodedAuthority}"
        WebViewCompat.addWebMessageListener(view, "FloatNative", setOf(origin)) { _, message, _, mainFrame, proxy ->
            if (!mainFrame) return@addWebMessageListener
            val data = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
            val target = data.optString("id") to proxy
            try {
                when (data.getString("op")) {
                    "permission" -> reply(target, notificationsEnabled())
                    "requestPermission" -> {
                        if (notificationsEnabled()) reply(target, true)
                        else if (Build.VERSION.SDK_INT >= 33 && permissionReply == null) {
                            permissionReply = target
                            permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        } else reply(target, false)
                    }
                    "notify" -> {
                        if (notificationsEnabled()) {
                            val manager = activity.getSystemService(NotificationManager::class.java)
                            manager.createNotificationChannel(NotificationChannel("shell_local_messages", "聊天消息提醒", NotificationManager.IMPORTANCE_HIGH))
                            val intent = PendingIntent.getActivity(activity, 0, Intent(activity, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
                            manager.notify(notificationId++, NotificationCompat.Builder(activity, "shell_local_messages")
                                .setSmallIcon(R.drawable.ic_stat).setContentTitle(data.optString("title").take(200))
                                .setContentText(data.optString("body").take(4000)).setContentIntent(intent).setAutoCancel(true).build())
                        }
                        reply(target, true)
                    }
                    "begin" -> {
                        check(pendingSave == null && output == null) { "另一个文件正在保存，请稍后重试" }
                        expected = data.getLong("size")
                        require(expected >= 0) { "文件大小无效" }
                        pendingSave = target
                        saveCanceled = false
                        try {
                            picker.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = data.optString("mime").ifBlank { "application/octet-stream" }
                                putExtra(Intent.EXTRA_TITLE, data.optString("name", "download").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(180))
                            })
                        } catch (e: Exception) { pendingSave = null; throw e }
                    }
                    "chunk", "finish", "abort" -> {
                        check(token != null && data.getString("token") == token) { "保存会话已失效" }
                        try {
                            when (data.getString("op")) {
                                "chunk" -> {
                                    val encoded = data.getString("data")
                                    require(encoded.length <= 350000) { "数据块过大" }
                                    val bytes = Base64.decode(encoded, Base64.NO_WRAP)
                                    require(written + bytes.size <= expected) { "文件大小不匹配" }
                                    output!!.write(bytes)
                                    written += bytes.size
                                }
                                "finish" -> {
                                    check(written == expected) { "文件传输不完整" }
                                    output!!.close()
                                    output = null; outputUri = null; token = null
                                    Toast.makeText(activity, "文件已保存", Toast.LENGTH_SHORT).show()
                                }
                                "abort" -> abort()
                            }
                        } catch (e: Exception) { abort(); throw e }
                        reply(target, true)
                    }
                    else -> error("不支持的操作")
                }
            } catch (e: Exception) { reply(target, error = e.message ?: "操作失败") }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, script(), setOf(origin))
        }
    }

    private fun script() = activity.assets.open("native-capabilities.js").bufferedReader().use { it.readText() }
    fun reset() {
        pendingSave?.let { reply(it, error = "页面已关闭，保存已取消") }
        saveCanceled = true
        // Keep picker ownership until it returns, so a second request cannot steal its result.
        abort()
    }
    fun onPageFinished(view: WebView) {
        val site = Uri.parse(MainActivity.SITE_URL)
        val current = Uri.parse(view.url ?: "")
        if (site.scheme == current.scheme && site.encodedAuthority == current.encodedAuthority) view.evaluateJavascript(script(), null)
    }
    fun abort() {
        runCatching { output?.close() }
        // Only remove the newly created, incomplete document, never an existing user file.
        outputUri?.let { runCatching { android.provider.DocumentsContract.deleteDocument(activity.contentResolver, it) } }
        output = null; outputUri = null; token = null
    }
}
