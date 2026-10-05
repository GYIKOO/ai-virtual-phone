package app.floatphone.shell;

import java.util.Locale;

/** Only relax JavaScript-only requests; mixed media/package requests keep WebView's filter. */
public final class PluginFilePolicy {
    private PluginFilePolicy() {}

    public static boolean isJavaScriptOnly(String[] acceptTypes) {
        if (acceptTypes == null) return false;
        boolean found = false;
        for (String group : acceptTypes) {
            if (group == null) continue;
            for (String raw : group.split(",")) {
                String type = raw.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                switch (type) {
                    case ".js":
                    case ".mjs":
                    case "text/javascript":
                    case "application/javascript":
                    case "application/x-javascript":
                    case "text/ecmascript":
                    case "application/ecmascript":
                        found = true;
                        break;
                    default:
                        return false;
                }
            }
        }
        return found;
    }

    public static boolean isAllowedName(String name) {
        if (name == null || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) return false;
        for (int i = 0; i < name.length(); i++) {
            if (Character.isISOControl(name.charAt(i))) return false;
        }
        String lower = name.toLowerCase(Locale.ROOT);
        return (lower.endsWith(".js") && name.length() > 3)
                || (lower.endsWith(".mjs") && name.length() > 4);
    }
}
