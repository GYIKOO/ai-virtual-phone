package app.floatphone.shell

import org.json.JSONArray
import org.json.JSONObject

/** Document-scoped feature grants, populated only through the authenticated bridge. */
object NativeBridgePolicy {
    @Volatile private var policy = JSONObject()
    @Volatile var revision: Long = 0L
        private set
    @Volatile var document: Long = 0L
        private set

    @Synchronized fun reset() { policy = JSONObject(); revision++; document++ }
    @Synchronized fun configure(next: JSONObject) {
        if (next.toString() != policy.toString()) { policy = JSONObject(next.toString()); revision++ }
    }
    fun captureAllowed(): Boolean = policy.optBoolean("screenshot", false)
    fun checkInAllowed(characterId: String): Boolean = policy.optJSONObject("checkIns")?.optBoolean(characterId, false) == true
    fun ballAllowed(): Boolean = captureAllowed() && policy.optBoolean("screenshotBall", false)
    fun perceptionAllowed(capability: String): Boolean = policy.optJSONObject("perception")?.optBoolean(capability, false) == true

    fun requireAllowed(namespace: String, method: String, args: JSONArray) {
        fun requireFlag(allowed: Boolean) { check(allowed) { "此设备功能尚未开启或授权已撤销。" } }
        if (namespace == "PhoneWidget") {
            if (method in setOf("update", "refresh")) requireFlag(policy.optBoolean("widget", false))
            return
        }
        val action = when (method) {
            "setTorch" -> "torch"; "setVolume" -> "volume"; "setBrightness" -> "brightness"
            "setDnd" -> "dnd"; "openApp", "launchExternalApp" -> "openApp"; "setAlarm" -> "alarm"
            "setTimer" -> "timer"; "mediaControl" -> "media"; "openWebUrl", "openUrl" -> "openUrl"
            else -> null
        }
        if (action != null) requireFlag(policy.optJSONObject("actions")?.optBoolean(action, false) == true)
        when (method) {
            "readUsageStats" -> requireFlag(perceptionAllowed("usageStats"))
            "readLocation", "refreshLocation", "getLocationDiagnostics" -> requireFlag(perceptionAllowed("location"))
            "readSleep", "refreshHealth", "getHealthDiagnostics" -> requireFlag(perceptionAllowed("sleep"))
            "readCalendarEvents" -> requireFlag(policy.optBoolean("calendarRead", false))
            "insertCalendarEvent", "deleteCalendarEvent" -> requireFlag(policy.optBoolean("calendarWrite", false))
            "captureScreenshot", "consumePendingUserShot" -> requireFlag(captureAllowed())
            "prepareScreenshotBall" -> requireFlag(ballAllowed())
            "requestCheckIn" -> requireFlag(checkInAllowed(args.optString(0)))
        }
    }

    /** Strip disabled raw fields before they cross the native boundary. */
    fun filterPerception(raw: String): String {
        val result = JSONObject(raw)
        if (!perceptionAllowed("battery")) result.remove("battery")
        if (!perceptionAllowed("network")) result.remove("network")
        if (!perceptionAllowed("foregroundApp")) result.remove("foregroundApp")
        if (!perceptionAllowed("steps")) result.remove("steps")
        return result.toString()
    }
}
