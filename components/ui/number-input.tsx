"use client";

import { useState, type InputHTMLAttributes } from "react";

type NumberInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onChange"> & {
  value: number;
  onValueChange: (value: number) => void;
};

/** Keep incomplete edits out of settings/storage; normalize only on blur or Enter. */
export function NumberInput({ value, onValueChange, onFocus, onBlur, onKeyDown, min, max, ...props }: NumberInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (text: string) => {
    setDraft(null);
    if (!text.trim()) return; // Empty edits restore the last saved value, including zero.
    let next = Number(text);
    if (!Number.isFinite(next)) return;
    if (min !== undefined && Number.isFinite(Number(min))) next = Math.max(Number(min), next);
    if (max !== undefined && Number.isFinite(Number(max))) next = Math.min(Number(max), next);
    if (next !== value) onValueChange(next);
  };
  return <input {...props} type="number" min={min} max={max} value={draft ?? value}
    onFocus={event => { setDraft(String(value)); onFocus?.(event); }}
    onChange={event => setDraft(event.target.value)}
    onBlur={event => { commit(event.currentTarget.value); onBlur?.(event); }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing) return;
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.value = String(value);
        setDraft(null);
        event.currentTarget.blur();
      }
    }} />;
}
