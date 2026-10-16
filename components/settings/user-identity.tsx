"use client";

import { useState, useEffect, useCallback, useContext } from "react";
import { Plus, User, Trash2, FileEdit, AlertCircle } from "lucide-react";
import { SettingsContext } from "../phone-settings-app";
import { loadUserIdentities, saveUserIdentities } from "@/lib/settings-storage";
import { ConfirmDialog } from "@/components/ui/modal";
import {
    createEmptyUserIdentity,
    UserIdentityEditorSheet,
    type UserIdentity,
} from "./user-identity-editor-sheet";

export type { UserIdentity } from "./user-identity-editor-sheet";

const DEFAULT_IDENTITIES: UserIdentity[] = [
    {
        id: "identity-1",
        name: "李斯特",
        bio: "一个普通的上班族，喜欢在周末去咖啡馆看书。",
        gender: "男",
        age: "26",
        occupation: "程序员",
        customSettings: "性格温和，说话带有一点理性逻辑。",
    },
    {
        id: "identity-2",
        name: "匿名用户",
        bio: "神秘的过客。",
        gender: "保密",
        age: "未知",
        occupation: "自由职业者",
        customSettings: "说话简短，带有神秘色彩。",
    }
];

export function UserIdentitySettings() {
    const { setSubpageRightAction } = useContext(SettingsContext);
    const [identities, setIdentitiesRaw] = useState<UserIdentity[]>([]);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [isNewIdentity, setIsNewIdentity] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    useEffect(() => {
        const saved = loadUserIdentities();
        if (saved.length > 0) {
            setIdentitiesRaw(saved);
        } else {
            setIdentitiesRaw(DEFAULT_IDENTITIES);
            saveUserIdentities(DEFAULT_IDENTITIES);
        }
    }, []);

    const setIdentities = useCallback((next: UserIdentity[]) => {
        setIdentitiesRaw(next);
        saveUserIdentities(next);
    }, []);

    const addIdentity = useCallback(() => {
        const newIdentity = createEmptyUserIdentity();
        const next = [newIdentity, ...identities];
        setIdentities(next);
        setIsNewIdentity(true);
        setEditingId(newIdentity.id);
    }, [identities, setIdentities]);

    useEffect(() => {
        setSubpageRightAction("identity",
            <button
                onClick={addIdentity}
                className="inline-flex h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-[20px] bg-black px-4 text-xs font-bold text-white shadow-sm transition-all hover:bg-gray-800 hover:shadow-md active:scale-95 focus:outline-none"
            >
                <Plus size={15} strokeWidth={1.8} />
                <span>新增身份</span>
            </button>
        );
        return () => setSubpageRightAction("identity", null);
    }, [addIdentity, setSubpageRightAction]);

    const updateIdentity = (id: string, updates: Partial<UserIdentity>) => {
        setIdentities(identities.map(i => i.id === id ? { ...i, ...updates } : i));
    };

    const removeIdentity = (id: string) => {
        const next = identities.filter(i => i.id !== id);
        setIdentities(next);
        if (editingId === id) {
            setEditingId(null);
            setIsNewIdentity(false);
        }
    };

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">User Identity</h2>
            </div>

            {identities.length === 0 ? (
                <div className="ui-empty">
                    <div className="ui-icon-circle">
                        <User size={24} />
                    </div>
                    <span className="menu-label font-semibold">没有身份卡片</span>
                    <span className="menu-desc max-w-[240px]">
                        在此管理您的个人身份信息，以便 AI 能够更好地了解您。
                    </span>
                    <button onClick={addIdentity} className="ui-btn ui-btn-primary rounded-[20px] mt-2">
                        <Plus size={16} /> 添加身份
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-3">
                    {identities.map(identity => (
                        <div
                            key={identity.id}
                            className="ui-config-card min-w-0 cursor-pointer overflow-hidden"
                            style={{ aspectRatio: "3 / 2", padding: "12px", justifyContent: "space-between" }}
                            role="button"
                            tabIndex={0}
                            aria-label={`编辑 ${identity.name || "身份"}`}
                            onClick={() => setEditingId(identity.id)}
                            onKeyDown={(event) => {
                                if (event.target !== event.currentTarget) return;
                                if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    setEditingId(identity.id);
                                }
                            }}
                        >
                            <div className="min-w-0 flex flex-col gap-1">
                                <span className="truncate text-[calc(14.4px*var(--app-text-scale,1))] font-bold leading-tight text-[var(--c-text-title)]">{identity.name || "未命名身份"}</span>
                                <span className="menu-desc truncate">{identity.occupation || identity.bio || identity.gender || "未填写身份信息"}</span>
                            </div>
                            <div className="flex items-end justify-between gap-2">
                                {identity.avatarUrl ? (
                                    <img src={identity.avatarUrl} alt={identity.name} className="h-9 w-9 rounded-full object-cover shrink-0" />
                                ) : (
                                    <div className="h-9 w-9 rounded-full bg-[var(--c-page-body-bg)] text-[var(--c-icon)] grid place-items-center shrink-0">
                                        <User size={18} />
                                    </div>
                                )}

                                <div className="flex gap-2 shrink-0 items-center">
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setEditingId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                    >
                                        <FileEdit size={18} />
                                    </button>
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            setConfirmDeleteId(identity.id);
                                        }}
                                        className="ui-link-btn"
                                        data-variant="danger"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {editingId && (() => {
                const identity = identities.find(item => item.id === editingId);
                if (!identity) return null;
                return (
                    <UserIdentityEditorSheet
                        identity={identity}
                        title={isNewIdentity ? "添加身份" : "编辑身份"}
                        onChange={(updates) => updateIdentity(identity.id, updates)}
                        onCancel={() => {
                            if (isNewIdentity) removeIdentity(identity.id);
                            setIsNewIdentity(false);
                            setEditingId(null);
                        }}
                        onConfirm={() => {
                            setIsNewIdentity(false);
                            setEditingId(null);
                        }}
                    />
                );
            })()}

            {confirmDeleteId && (
                <ConfirmDialog
                    title="确认删除？"
                    message="删除身份卡片后无法恢复。是否继续？"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        removeIdentity(confirmDeleteId);
                        setConfirmDeleteId(null);
                    }}
                    onCancel={() => setConfirmDeleteId(null)}
                />
            )}
        </div>
    );
}
