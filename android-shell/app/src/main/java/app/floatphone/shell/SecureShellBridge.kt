package app.floatphone.shell

import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.Method
import java.security.SecureRandom

/** Explicit RPC allowlist. These methods are not exposed with @JavascriptInterface. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
annotation class ShellMethod

/**
 * A main-frame/origin checked handshake issues an unguessable document capability.
 * Only a capability-gated dispatcher is visible to other frames. Keeping synchronous
 * calls after the handshake preserves the upstream bridge's return-value contract.
 */
class SecureShellBridge(private val view: WebView, shell: Any, widget: Any) {
    private val targets = mapOf("AndroidShell" to shell, "PhoneWidget" to widget)
    private val methods: Map<String, Map<String, Method>> = targets.mapValues { (_, target) ->
        target.javaClass.declaredMethods.filter { it.isAnnotationPresent(ShellMethod::class.java) }
            .associateBy { it.name }
    }
    @Volatile private var token: String? = null
    private var installed = false
    private val script by lazy { view.context.assets.open("secure-shell.js").bufferedReader().use { it.readText() } }

    fun install() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val site = Uri.parse(MainActivity.SITE_URL)
        val origin = "${site.scheme}://${site.encodedAuthority}"
        view.addJavascriptInterface(Dispatcher(), "FloatShellRpc")
        WebViewCompat.addWebMessageListener(view, "FloatShellHandshake", setOf(origin)) { _, message, source, mainFrame, reply ->
            if (!mainFrame || !isTrustedOrigin(source.toString()) || message.data != "hello") return@addWebMessageListener
            val secret = token ?: ByteArray(32).also { SecureRandom().nextBytes(it) }
                .joinToString("") { "%02x".format(it) }.also { token = it }
            val manifest = JSONObject()
            methods.forEach { (namespace, entries) -> manifest.put(namespace, JSONArray(entries.keys.toList())) }
            reply.postMessage(JSONObject().put("token", secret).put("methods", manifest).toString())
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, script, setOf(origin))
        }
        installed = true
    }

    fun reset() { token = null; NativeBridgePolicy.reset() }

    fun onPageFinished(url: String) {
        if (installed && isTrustedOrigin(url)) view.evaluateJavascript(script, null)
    }

    inner class Dispatcher {
        @JavascriptInterface
        fun invoke(secret: String, namespace: String, name: String, arguments: String): String {
            return try {
                check(token != null && secret == token) { "页面授权已失效，请重新打开页面。" }
                require(arguments.length <= 24 * 1024 * 1024) { "请求内容过大。" }
                val args = JSONArray(arguments)
                if (namespace == "Policy" && name == "configure") {
                    require(args.length() == 1)
                    NativeBridgePolicy.configure(args.getJSONObject(0))
                    return JSONObject().put("ok", true).put("value", true).toString()
                }
                val method = methods[namespace]?.get(name) ?: error("不支持的设备操作。")
                require(method.parameterTypes.size == args.length()) { "设备操作参数数量不正确。" }
                NativeBridgePolicy.requireAllowed(namespace, name, args)
                val converted = method.parameterTypes.mapIndexed { i, type -> convert(args.opt(i), type) }.toTypedArray()
                val value = method.invoke(targets.getValue(namespace), *converted)
                JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL).toString()
            } catch (error: Exception) {
                JSONObject().put("ok", false).put("error", error.cause?.message ?: error.message ?: "设备操作失败。").toString()
            }
        }
    }

    private fun convert(raw: Any?, type: Class<*>): Any? = when (type) {
        String::class.java -> if (raw == null || raw == JSONObject.NULL) null else {
            require(raw is String) { "需要文本参数。" }; raw
        }
        Boolean::class.javaPrimitiveType -> { require(raw is Boolean) { "需要开关参数。" }; raw }
        Int::class.javaPrimitiveType -> {
            require(raw is Number && raw.toDouble().isFinite() && raw.toDouble() == raw.toInt().toDouble()) { "需要整数参数。" }; raw.toInt()
        }
        Long::class.javaPrimitiveType -> {
            require(raw is Number && raw.toDouble().isFinite() && raw.toDouble() == raw.toLong().toDouble()) { "需要整数参数。" }; raw.toLong()
        }
        else -> error("不支持的参数类型。")
    }

    companion object {
        fun isTrustedOrigin(url: String?): Boolean = runCatching {
            val target = Uri.parse(url ?: "")
            val site = Uri.parse(MainActivity.SITE_URL)
            target.scheme in listOf("https", "http") && target.scheme == site.scheme &&
                target.encodedAuthority == site.encodedAuthority
        }.getOrDefault(false)
    }
}
