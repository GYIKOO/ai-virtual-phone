package app.floatphone.shell

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Device-local, excluded from Android backups. Never stores a project admin key. */
object PersonalPushConnection {
    private fun file(context: Context) = File(context.noBackupFilesDir, "personal-push.json")

    @Synchronized fun read(context: Context): JSONObject = runCatching {
        JSONObject(file(context).readText())
    }.getOrElse { JSONObject() }

    @Synchronized fun identity(context: Context): String {
        val state = read(context)
        val existing = state.optString("deviceId")
        if (existing.isNotBlank()) return existing
        val id = UUID.randomUUID().toString() + UUID.randomUUID().toString()
        state.put("deviceId", id)
        file(context).writeText(state.toString())
        return id
    }

    @Synchronized fun configure(context: Context, config: JSONObject?) {
        val previous = read(context)
        val state = JSONObject().put("deviceId", identity(context)).put("managed", true)
            .put("lastUrl", previous.optJSONObject("config")?.optString("url") ?: previous.optString("lastUrl"))
        if (config != null) {
            val url = config.getString("url")
            val channel = config.getString("channelId")
            val key = config.getString("anonKey")
            require(Regex("https://[a-z0-9-]+\\.supabase\\.co").matches(url)) { "个人云地址无效" }
            require(channel == "device:" + state.getString("deviceId")) { "设备通道不匹配" }
            require(key.startsWith("sb_publishable_") || runCatching {
                val payload = key.split('.')[1]
                JSONObject(String(android.util.Base64.decode(payload, android.util.Base64.URL_SAFE)))
                    .optString("role") == "anon"
            }.getOrDefault(false)) { "只允许公开连接密钥，不接受管理密钥" }
            state.put("config", JSONObject().put("url", url).put("channelId", channel).put("anonKey", key))
        }
        file(context).writeText(state.toString())
    }
}
