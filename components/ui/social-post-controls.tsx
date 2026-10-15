"use client";

import { useId } from "react";
import { NumberInput } from "./number-input";
import { Toggle } from "./form";
import { getSocialPostProbability, isSocialPostLinked, setSocialPostLinked, setSocialPostProbability, type SocialPostApp, type SocialPostConfig } from "@/lib/social-post-probability";
import styles from "./social-post-controls.module.css";

export function ProbabilityControl({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
    const id = useId();
    return <div className={styles.probability}>
        <div className={styles.row}>
            <label htmlFor={id}>{label}</label>
            <span className={styles.number}><NumberInput id={id} aria-label={label} min={0} max={100} step={1} value={value} onValueChange={onChange} />%</span>
        </div>
        <input className={styles.range} aria-label={`${label}滑块`} type="range" min={0} max={100} step={5} value={value} onChange={event => onChange(Number(event.target.value))} />
    </div>;
}

export function SocialPostControls({ characterId, app, config, onChange }: {
    characterId: string;
    app: SocialPostApp;
    config: SocialPostConfig;
    onChange: (patch: Partial<SocialPostConfig>) => void;
}) {
    const linked = isSocialPostLinked(characterId, config);
    return <div className={styles.controls}>
        <ProbabilityControl label="发帖概率" value={Math.round(getSocialPostProbability(characterId, app, config) * 100)}
            onChange={value => onChange(setSocialPostProbability(characterId, app, value / 100, config))} />
        <label className={styles.row}>
            <span>与{app === "moments" ? "小红书" : "朋友圈"}共用概率</span>
            <Toggle checked={linked} onChange={value => onChange(setSocialPostLinked(characterId, app, value, config))} />
        </label>
        <p className={styles.hint}>{linked ? "两边修改会同步；参与角色与触发时机各自独立。" : "当前独立设置；开启共用后，两边采用此处概率。"}</p>
    </div>;
}
