"use client";

import { Camera, Check, Link, User, X } from "lucide-react";
import { Input } from "@/components/ui/form";

export type UserIdentity = {
    id: string;
    name: string;
    avatarUrl?: string;
    bio: string;
    gender: string;
    age: string;
    occupation: string;
    customSettings: string;
};

export function createEmptyUserIdentity(): UserIdentity {
    return {
        id: `identity-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: "新身份",
        bio: "",
        gender: "保密",
        age: "",
        occupation: "",
        customSettings: "",
    };
}

function fileToDataUrl(file: File, maxSize = 400, quality = 0.8): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement("canvas");
                const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext("2d");
                if (!ctx) return reject(new Error("无法处理头像"));
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/webp", quality));
            };
            img.onerror = reject;
            img.src = reader.result as string;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export function UserIdentityEditorSheet({
    identity,
    title,
    onChange,
    onCancel,
    onConfirm,
}: {
    identity: UserIdentity;
    title: string;
    onChange: (updates: Partial<UserIdentity>) => void;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div className="modal-overlay modal-overlay-bottom">
            <div className="modal-sheet" data-ui="modal-sheet">
                <div className="modal-header" data-ui="modal-header">
                    <button type="button" onClick={onCancel} className="modal-header-btn modal-header-btn-muted" aria-label="取消">
                        <X size={18} />
                    </button>
                    <span className="modal-header-title">{title}</span>
                    <button type="button" onClick={onConfirm} className="modal-header-btn modal-header-btn-action" aria-label="保存">
                        <Check size={18} />
                    </button>
                </div>

                <div className="modal-body hide-scrollbar flex flex-col gap-4 pb-10" data-ui="modal-body">
                    <div className="flex flex-col items-center gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                const input = document.createElement("input");
                                input.type = "file";
                                input.accept = "image/*";
                                input.onchange = async () => {
                                    const file = input.files?.[0];
                                    if (!file) return;
                                    try {
                                        onChange({ avatarUrl: await fileToDataUrl(file) });
                                    } catch { /* 保留原头像 */ }
                                };
                                input.click();
                            }}
                            className="ui-avatar-upload"
                            aria-label="从相册选择头像"
                        >
                            {identity.avatarUrl ? (
                                <>
                                    <img src={identity.avatarUrl} alt="" className="h-full w-full object-cover" />
                                    <div className="absolute inset-x-0 bottom-0 flex justify-center ui-avatar-upload-overlay">
                                        <Camera size={14} color="#fff" />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <User size={28} className="text-[var(--c-icon-active)]" />
                                    <span className="ts-10 mt-[2px] text-[var(--c-icon-active)]">点击上传</span>
                                </>
                            )}
                        </button>
                        <div className="flex w-full max-w-[280px] items-center gap-[6px]">
                            <Link size={14} className="shrink-0 text-[var(--c-text)]" />
                            <Input
                                type="text"
                                value={identity.avatarUrl?.startsWith("data:") ? "" : (identity.avatarUrl || "")}
                                onChange={(event) => onChange({ avatarUrl: event.target.value })}
                                placeholder="或粘贴图片URL..."
                                className="flex-1 px-[10px] py-[6px] ts-12"
                            />
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <label className="menu-desc ml-1">名字 (Name)</label>
                            <Input
                                type="text"
                                value={identity.name}
                                onChange={(event) => onChange({ name: event.target.value })}
                                placeholder="您希望AI怎么称呼您..."
                                className="font-medium"
                            />
                        </div>
                        <div className="flex w-[90px] shrink-0 flex-col gap-1">
                            <label className="menu-desc ml-1">性别</label>
                            <select value={identity.gender} onChange={(event) => onChange({ gender: event.target.value })} className="ui-select">
                                <option value="保密">保密</option>
                                <option value="男">男</option>
                                <option value="女">女</option>
                                <option value="其他">其他</option>
                            </select>
                        </div>
                    </div>

                    <div className="flex gap-3">
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <label className="menu-desc ml-1">年龄 (Age)</label>
                            <input type="text" value={identity.age} onChange={(event) => onChange({ age: event.target.value })} placeholder="例如: 24, 未知" className="ui-input" />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <label className="menu-desc ml-1">职业 (Occupation)</label>
                            <input type="text" value={identity.occupation} onChange={(event) => onChange({ occupation: event.target.value })} placeholder="例如: 学生, 自由职业" className="ui-input" />
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">简介 (Bio)</label>
                        <textarea value={identity.bio} onChange={(event) => onChange({ bio: event.target.value })} placeholder="简单描述一下自己，这会作为AI了解您的基础背景..." rows={3} className="ui-textarea" />
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">自定义设定 (Custom Settings)</label>
                        <textarea value={identity.customSettings} onChange={(event) => onChange({ customSettings: event.target.value })} placeholder="更深度的性格爱好描述，对话的特殊要求等..." rows={4} className="ui-textarea" />
                    </div>
                </div>
            </div>
        </div>
    );
}
