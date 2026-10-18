export const USER_FONT_FAMILY = "AIVirtualPhoneUserFont";

export function installDesktopFont(url: string | null): void {
  if (typeof document === "undefined") return;
  const id = "ai-phone-theme-font-face";
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    document.head.append(style);
  }
  const css = url ? `@font-face{font-family:"${USER_FONT_FAMILY}";src:url(${JSON.stringify(url)});font-display:swap;}` : "";
  if (style.textContent !== css) style.textContent = css;
}

async function loadFontsWithin(specs: string[], text?: string): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(specs.map(spec => Promise.resolve().then(() => document.fonts.load(spec, text)).catch(() => []))),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only the three families actually used by the splash canvas. */
export function warmDesktopBuiltinFonts(): Promise<void> {
  return loadFontsWithin(['400 1em "Inter"', '400 1em "Instrument Serif"', '400 1em "JetBrains Mono"']);
}

export async function prepareDesktopFont(url: string | null): Promise<void> {
  installDesktopFont(url);
  if (url) await loadFontsWithin([`400 1em "${USER_FONT_FAMILY}"`], "桌面消息设置 Aa 0123");
}
