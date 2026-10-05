package app.floatphone.shell;

public final class PluginFilePolicyTest {
    private static void check(boolean result, String label) {
        if (!result) throw new AssertionError(label);
    }

    public static void main(String[] args) {
        check(PluginFilePolicy.isJavaScriptOnly(new String[]{".js,.mjs,text/javascript"}), "web accept");
        check(PluginFilePolicy.isJavaScriptOnly(new String[]{" APPLICATION/JAVASCRIPT ", ".MJS"}), "MIME normalization");
        for (String[] types : new String[][]{null, {}, {""}, {"*/*"}, {"image/*"}, {"audio/*"}, {".zip"}, {".json"}, {".js,.zip"}, {"text/plain"}}) {
            check(!PluginFilePolicy.isJavaScriptOnly(types), "unrelated picker unchanged");
        }
        for (String name : new String[]{"插件.js", "插件-v2.MJS", "my.plugin.JS"}) {
            check(PluginFilePolicy.isAllowedName(name), "accept " + name);
        }
        for (String name : new String[]{null, "", ".js", ".mjs", "x.js.txt", "x.zip", "x.json", "x.js ", "x.js\n", "dir/x.js", "dir\\x.js"}) {
            check(!PluginFilePolicy.isAllowedName(name), "reject " + name);
        }
        System.out.println("PASS: JS-only picker scope and filename validation");
    }
}
