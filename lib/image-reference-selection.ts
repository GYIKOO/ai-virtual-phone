/**
 * The chat/moments text model writes the image description. This detector turns
 * that model-authored description into the final user-reference decision. The
 * UI switch remains an explicit permission gate; scenery/object-only pictures
 * never receive the user's face reference merely because the gate is enabled.
 */
export function descriptionNeedsUserReference(description: string, userName?: string): boolean {
    const text = description.trim().toLowerCase();
    if (!text) return false;
    const normalizedName = userName?.trim().toLowerCase();
    if (normalizedName && text.includes(normalizedName)) return true;
    return /(?:合照|合影|双人|两个人|二人|情侣照|我们.{0,8}(?:照片|自拍|合影)|(?:和|与|同).{0,12}(?:用户|你).{0,8}(?:照片|自拍|合影)|(?:用户|你本人|你的脸|你的肖像|user).{0,8}(?:照片|肖像|自拍|出镜)|(?:画面|照片).{0,10}(?:出现|包含).{0,8}(?:用户|你))/.test(text);
}
