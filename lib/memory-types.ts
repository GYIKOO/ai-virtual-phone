// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    summarizationRoundInterval?: number;   // absent preserves legacy event counting
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    storyContextTokenLimit?: number;       // whole ensemble request window, including output reserve
    contextTokenLimit?: number;            // shared request window; legacy story limit remains a read fallback
    recentContextDetail?: "compact" | "standard" | "detailed";
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称，按事件先后整理{{char}}的经历及与相关人物的互动
- 保留关键人物、事件经过与因果、约定、目标、关系和情感变化，以及影响后续的未完成事项
- 保留人物分享的具体信息（生日、偏好、习惯），以及朋友圈等非聊天事件中的关键信息
- 沿用记录中明确的发生时间或时间范围；区分已经发生的事、未来计划和人物的推测，时间不明时保持未知
- 合并重复信息，以事实为依据。普通批次约300-600字；内容少时简短概括，信息密集时可适当增加篇幅
- 不要包含格式标记

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 提炼最稳定、最重要、持续影响后续理解与行动的事实
- 保留人物身份与关系的明确变化、重要经历及其长期影响、长期目标、关键约定和持续有效的个人信息
- 关系性质和亲疏以记录为准，保留相关人物各自的立场与知情范围
- 日常交流、情绪和偏好按其持续影响取舍；将已确定的事实与尚未实现的目标或约定分清
- 保留关键事件已有的发生时间或时间范围；时间不明时保持未知
- 用第三人称，合并重复信息，作事实性概括
- 通常80-180字；关键事实较多时可适当增加篇幅
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    summarizationRoundInterval: 30,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 60000,
    coreMemoryTokenBudget: 6000,
    longTermTokenBudget: 12000,
    storyContextTokenLimit: 100000,
    contextTokenLimit: 100000,
    recentContextDetail: "detailed",
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};

export type MemorySettingsSection = "context" | "budgets" | "intervals";

/** Restore only the selected settings; histories, prompts and switches are untouched. */
export function restoreMemorySettingsSection(config: MemoryConfig, section: MemorySettingsSection): MemoryConfig {
    const defaults = DEFAULT_MEMORY_CONFIG;
    switch (section) {
        case "context":
            return { ...config, contextTokenLimit: defaults.contextTokenLimit, recentContextDetail: defaults.recentContextDetail };
        case "budgets":
            return { ...config, shortTermTokenBudget: defaults.shortTermTokenBudget,
                longTermTokenBudget: defaults.longTermTokenBudget, coreMemoryTokenBudget: defaults.coreMemoryTokenBudget };
        case "intervals":
            return { ...config, summarizationRoundInterval: defaults.summarizationRoundInterval,
                coreSummarizationInterval: defaults.coreSummarizationInterval };
    }
}
