/** Remove configured non-context blocks without changing other narrative markup. */
export function stripNarrativeTags(text: string, excludedTags: string): string {
  const tags = new Set(excludedTags.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean));
  if (!tags.size) return text;
  const stack: string[] = [];
  let cursor = 0, clean = "";
  for (const match of text.matchAll(/<\s*(\/?)\s*([^\s<>/]+)(?:\s[^<>]*?)?\s*\/?>/g)) {
    const name = match[2].toLowerCase();
    if (!tags.has(name)) continue;
    const index = match.index!;
    if (!match[1]) {
      if (!stack.length) clean += text.slice(cursor, index);
      if (!/\/\s*>$/.test(match[0])) stack.push(name);
      else if (!stack.length) cursor = index + match[0].length;
    } else if (stack.length && stack[stack.length - 1] === name) {
      stack.pop();
      if (!stack.length) cursor = index + match[0].length;
    }
  }
  if (!stack.length) clean += text.slice(cursor);
  return clean.replace(/\n{3,}/g, "\n\n").trim();
}

/** A bounded quotation, not a generated summary. Never persist it as a new memory. */
export function narrativeExcerpt(text: string, excludedTags = "", maxLength = 500): string {
  const tags = ["think", "thought", "thinking", "story_theater", "summary", ...excludedTags.split(",")];
  let clean = stripNarrativeTags(text, tags.join(","));
  // Incomplete excluded blocks must not expose a partially generated reasoning tail.
  for (const tag of new Set(tags.map(value => value.trim()).filter(Boolean))) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clean = clean.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi"), "");
    clean = clean.replace(new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*$`, "gi"), "");
  }
  clean = clean.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}
