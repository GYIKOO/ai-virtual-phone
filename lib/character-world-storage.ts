import { loadCharacters } from "./character-storage";
import { loadChatContacts } from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import type { Character } from "./character-types";
import type { MomentComment, MomentLike, MomentPost } from "./moments-types";
import { loadUserIdentities, resolveUserIdentity } from "./settings-storage";
import { selectRelatedWorldRelations } from "./character-relation-context";

const CHARACTER_WORLDS_KEY = "ai_phone_character_worlds_v1";
export const CHARACTER_WORLDS_UPDATED_EVENT = "character-worlds-updated";
export const DEFAULT_CHARACTER_WORLD_ID = "world_default";
/** 关系网中的用户是特殊节点，不会被当作可聊天/可选剧情角色。 */
export const CHARACTER_WORLD_USER_NODE_ID = "__current_user_identity__";
export const CHARACTER_WORLD_USER_NODE_PREFIX = "__user_identity__:";

export function getCharacterWorldUserNodeId(identityId: string): string {
    return `${CHARACTER_WORLD_USER_NODE_PREFIX}${identityId}`;
}

export function getCharacterWorldUserIdentityId(nodeId: string): string | null {
    return nodeId.startsWith(CHARACTER_WORLD_USER_NODE_PREFIX)
        ? nodeId.slice(CHARACTER_WORLD_USER_NODE_PREFIX.length) || null
        : null;
}

registerKvMigration(CHARACTER_WORLDS_KEY);

export type CharacterWorldRelation = {
    id: string;
    fromCharacterId: string;
    toCharacterId: string;
    label: string;
};

export type CharacterWorldGroup = {
    id: string;
    name: string;
    description: string;
    memberIds: string[];
    relations: CharacterWorldRelation[];
    /** 手动加入当前世界的身份；角色绑定的身份会自动出现，无需重复保存。 */
    userIdentityIds: string[];
    userNodes: Record<string, {
        canvasX: number;
        canvasY: number;
        canvasRot: number;
        canvasZIndex: number;
    }>;
    createdAt: string;
    updatedAt: string;
};

function isBrowser(): boolean {
    return typeof window !== "undefined";
}

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function dispatchUpdated(): void {
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CHARACTER_WORLDS_UPDATED_EVENT));
    }
}

function createDefaultGroup(memberIds: string[], now = new Date().toISOString()): CharacterWorldGroup {
    return {
        id: DEFAULT_CHARACTER_WORLD_ID,
        name: "默认世界",
        description: "",
        memberIds,
        relations: [],
        userIdentityIds: [],
        userNodes: {},
        createdAt: now,
        updatedAt: now,
    };
}

function parseGroups(raw: string | null): CharacterWorldGroup[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizeGroups(groups: CharacterWorldGroup[], characters: Character[]): { groups: CharacterWorldGroup[]; changed: boolean } {
    const now = new Date().toISOString();
    const validIds = new Set(characters.map(character => character.id));
    const assigned = new Set<string>();
    const identities = loadUserIdentities();
    const validIdentityIds = new Set(identities.map(identity => identity.id));
    let changed = false;

    let normalized = groups
        .filter(group => group && typeof group.id === "string" && typeof group.name === "string")
        .map((group): CharacterWorldGroup => {
            const members: string[] = [];
            for (const memberId of Array.isArray(group.memberIds) ? group.memberIds : []) {
                if (!validIds.has(memberId) || assigned.has(memberId)) {
                    changed = true;
                    continue;
                }
                assigned.add(memberId);
                members.push(memberId);
            }

            const rawGroup = group as CharacterWorldGroup & {
                userNode?: { canvasX?: number; canvasY?: number; canvasRot?: number; canvasZIndex?: number };
                userIdentityIds?: string[];
                userNodes?: CharacterWorldGroup["userNodes"];
            };
            if (!Array.isArray(rawGroup.userIdentityIds) || !rawGroup.userNodes) changed = true;
            const userIdentityIds = Array.from(new Set(
                (Array.isArray(rawGroup.userIdentityIds) ? rawGroup.userIdentityIds : [])
                    .filter(identityId => validIdentityIds.has(identityId))
            ));
            const boundIdentityIds = members
                .map(memberId => resolveUserIdentity(memberId)?.id)
                .filter((identityId): identityId is string => Boolean(identityId));
            const defaultIdentityId = resolveUserIdentity()?.id || identities[0]?.id;
            const visibleIdentityIds = Array.from(new Set([
                ...userIdentityIds,
                ...boundIdentityIds,
                ...(userIdentityIds.length === 0 && boundIdentityIds.length === 0 && defaultIdentityId ? [defaultIdentityId] : []),
            ]));
            const fallbackIdentityId = visibleIdentityIds[0] || defaultIdentityId;
            const userNodes: CharacterWorldGroup["userNodes"] = {};
            visibleIdentityIds.forEach((identityId, index) => {
                const stored = rawGroup.userNodes?.[identityId];
                const legacy = index === 0 ? rawGroup.userNode : undefined;
                const source = stored || legacy;
                userNodes[identityId] = {
                    canvasX: Number.isFinite(source?.canvasX) ? Number(source?.canvasX) : 70 + index * 150,
                    canvasY: Number.isFinite(source?.canvasY) ? Number(source?.canvasY) : 90 + (index % 2) * 180,
                    canvasRot: Number.isFinite(source?.canvasRot) ? Number(source?.canvasRot) : -3 + index * 2,
                    canvasZIndex: Number.isFinite(source?.canvasZIndex) ? Number(source?.canvasZIndex) : 180 + index,
                };
            });
            const validUserNodeIds = new Set(identities.map(identity => getCharacterWorldUserNodeId(identity.id)));
            const memberSet = new Set([...members, ...validUserNodeIds]);
            const rawRelations = Array.isArray(group.relations) ? group.relations : [];
            if (rawRelations.some(relation => relation.fromCharacterId === CHARACTER_WORLD_USER_NODE_ID || relation.toCharacterId === CHARACTER_WORLD_USER_NODE_ID)) {
                changed = true;
            }
            const relations = rawRelations
                .map(relation => fallbackIdentityId ? {
                    ...relation,
                    fromCharacterId: relation.fromCharacterId === CHARACTER_WORLD_USER_NODE_ID
                        ? getCharacterWorldUserNodeId(fallbackIdentityId)
                        : relation.fromCharacterId,
                    toCharacterId: relation.toCharacterId === CHARACTER_WORLD_USER_NODE_ID
                        ? getCharacterWorldUserNodeId(fallbackIdentityId)
                        : relation.toCharacterId,
                } : relation)
                .filter(relation => (
                    relation
                    && typeof relation.id === "string"
                    && typeof relation.fromCharacterId === "string"
                    && typeof relation.toCharacterId === "string"
                    && typeof relation.label === "string"
                    && relation.label.trim()
                    && memberSet.has(relation.fromCharacterId)
                    && memberSet.has(relation.toCharacterId)
                    && relation.fromCharacterId !== relation.toCharacterId
                ))
                .map(relation => ({
                    ...relation,
                    label: relation.label.trim(),
                }));

            if (relations.length !== (Array.isArray(group.relations) ? group.relations.length : 0)) changed = true;

            return {
                id: group.id,
                name: group.name.trim() || "未命名世界",
                description: typeof group.description === "string" ? group.description.trim() : "",
                memberIds: members,
                relations,
                userIdentityIds,
                userNodes,
                createdAt: group.createdAt || now,
                updatedAt: group.updatedAt || now,
            };
        });

    if (normalized.length === 0) {
        changed = true;
        normalized = [createDefaultGroup(characters.map(character => character.id), now)];
        return { groups: normalized, changed };
    }

    let defaultGroup = normalized.find(group => group.id === DEFAULT_CHARACTER_WORLD_ID);
    if (!defaultGroup) {
        changed = true;
        defaultGroup = createDefaultGroup([], now);
        normalized = [defaultGroup, ...normalized];
    }

    const missingIds = characters.map(character => character.id).filter(id => !assigned.has(id));
    if (missingIds.length > 0) {
        changed = true;
        defaultGroup.memberIds = [...defaultGroup.memberIds, ...missingIds];
        defaultGroup.updatedAt = now;
    }

    return { groups: normalized, changed };
}

export function loadCharacterWorldGroups(): CharacterWorldGroup[] {
    const characters = loadCharacters();
    const { groups, changed } = normalizeGroups(parseGroups(kvGet(CHARACTER_WORLDS_KEY)), characters);
    if (changed && isBrowser()) {
        kvSet(CHARACTER_WORLDS_KEY, JSON.stringify(groups));
    }
    return groups;
}

export function saveCharacterWorldGroups(groups: CharacterWorldGroup[]): void {
    const { groups: normalized } = normalizeGroups(groups, loadCharacters());
    if (!isBrowser()) return;
    kvSet(CHARACTER_WORLDS_KEY, JSON.stringify(normalized));
    dispatchUpdated();
}

export function createCharacterWorldGroup(name: string): CharacterWorldGroup {
    const groups = loadCharacterWorldGroups();
    const now = new Date().toISOString();
    const group: CharacterWorldGroup = {
        id: generateId("world"),
        name: name.trim() || "新的世界",
        description: "",
        memberIds: [],
        relations: [],
        userIdentityIds: [],
        userNodes: {},
        createdAt: now,
        updatedAt: now,
    };
    saveCharacterWorldGroups([...groups, group]);
    return group;
}

export function renameCharacterWorldGroup(groupId: string, name: string): void {
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group =>
        group.id === groupId
            ? { ...group, name: name.trim() || group.name, updatedAt: now }
            : group
    ));
}

export function updateCharacterWorldDescription(groupId: string, description: string): void {
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group =>
        group.id === groupId
            ? { ...group, description, updatedAt: now }
            : group
    ));
}

export function deleteCharacterWorldGroup(groupId: string): void {
    if (groupId === DEFAULT_CHARACTER_WORLD_ID) return;
    const groups = loadCharacterWorldGroups();
    const target = groups.find(group => group.id === groupId);
    if (!target) return;
    const now = new Date().toISOString();
    saveCharacterWorldGroups(groups
        .filter(group => group.id !== groupId)
        .map(group => group.id === DEFAULT_CHARACTER_WORLD_ID
            ? { ...group, memberIds: [...group.memberIds, ...target.memberIds], updatedAt: now }
            : group
        ));
}

export function moveCharacterToWorld(characterId: string, groupId: string): void {
    moveCharactersToWorld([characterId], groupId);
}

/** Move a cohort in one write, carrying only relations between its members. */
export function moveCharactersToWorld(characterIds: string[], groupId: string): void {
    if (!Array.isArray(characterIds) || !characterIds.length
        || characterIds.some(id => typeof id !== "string" || !id)) {
        throw new Error("请选择要转移的角色。");
    }
    const selected = new Set(characterIds);
    const knownIds = new Set(loadCharacters().map(character => character.id));
    if ([...selected].some(id => !knownIds.has(id))) throw new Error("部分角色已不存在，请重新选择。");
    const groups = loadCharacterWorldGroups();
    const target = groups.find(group => group.id === groupId);
    if (!target) throw new Error("目标世界已不存在，请重新选择。");
    const moving = new Set([...selected].filter(id => !target.memberIds.includes(id)));
    if (!moving.size) return;
    const carried = groups.filter(group => group.id !== groupId).flatMap(group =>
        group.relations.filter(relation => moving.has(relation.fromCharacterId) && moving.has(relation.toCharacterId))
    );
    const relations = [...target.relations];
    const relationKey = (relation: CharacterWorldRelation) =>
        JSON.stringify([relation.fromCharacterId, relation.toCharacterId, relation.label.trim()]);
    const keys = new Set(relations.map(relationKey));
    const ids = new Set(relations.map(relation => relation.id));
    for (const relation of carried) {
        const key = relationKey(relation);
        if (keys.has(key)) continue;
        let id = relation.id;
        while (ids.has(id)) id = generateId("relation");
        relations.push({ ...relation, id });
        keys.add(key);
        ids.add(id);
    }
    const now = new Date().toISOString();
    saveCharacterWorldGroups(groups.map(group => {
        if (group.id === groupId) return {
            ...group, memberIds: [...target.memberIds, ...moving], relations, updatedAt: now,
        };
        if (!group.memberIds.some(id => moving.has(id))) return group;
        return {
            ...group,
            memberIds: group.memberIds.filter(id => !moving.has(id)),
            relations: group.relations.filter(relation =>
                !moving.has(relation.fromCharacterId) && !moving.has(relation.toCharacterId)
            ),
            updatedAt: now,
        };
    }));
}

export function addCharacterWorldRelation(groupId: string, fromCharacterId: string, toCharacterId: string, label: string): void {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || fromCharacterId === toCharacterId) return;
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group => {
        if (group.id !== groupId) return group;
        const memberSet = new Set([
            ...group.memberIds,
            ...loadUserIdentities().map(identity => getCharacterWorldUserNodeId(identity.id)),
        ]);
        if (!memberSet.has(fromCharacterId) || !memberSet.has(toCharacterId)) return group;
        return {
            ...group,
            relations: [
                ...group.relations,
                {
                    id: generateId("relation"),
                    fromCharacterId,
                    toCharacterId,
                    label: trimmedLabel,
                },
            ],
            updatedAt: now,
        };
    }));
}

export function addUserIdentityToCharacterWorld(groupId: string, identityId: string): void {
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group => {
        if (group.id !== groupId || group.userIdentityIds.includes(identityId)) return group;
        const index = Object.keys(group.userNodes).length;
        return {
            ...group,
            userIdentityIds: [...group.userIdentityIds, identityId],
            userNodes: {
                ...group.userNodes,
                [identityId]: { canvasX: 70 + index * 150, canvasY: 90 + (index % 2) * 180, canvasRot: -3 + index * 2, canvasZIndex: 180 + index },
            },
            updatedAt: now,
        };
    }));
}

export function updateCharacterWorldUserNodePosition(groupId: string, identityId: string, canvasX: number, canvasY: number): void {
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group => group.id === groupId ? {
        ...group,
        userNodes: {
            ...group.userNodes,
            [identityId]: {
                ...(group.userNodes[identityId] || { canvasRot: -3, canvasZIndex: 180 }),
                canvasX,
                canvasY,
            },
        },
        updatedAt: now,
    } : group));
}

export function deleteCharacterWorldRelation(groupId: string, relationId: string): void {
    const now = new Date().toISOString();
    saveCharacterWorldGroups(loadCharacterWorldGroups().map(group =>
        group.id === groupId
            ? { ...group, relations: group.relations.filter(relation => relation.id !== relationId), updatedAt: now }
            : group
    ));
}

export function getCharacterWorldGroupId(characterId: string): string | null {
    return loadCharacterWorldGroups().find(group => group.memberIds.includes(characterId))?.id ?? null;
}

export function getCharacterWorldGroup(characterId: string): CharacterWorldGroup | null {
    return loadCharacterWorldGroups().find(group => group.memberIds.includes(characterId)) ?? null;
}

export function areCharactersInSameWorld(firstCharacterId: string, secondCharacterId: string): boolean {
    if (!firstCharacterId || !secondCharacterId) return false;
    if (firstCharacterId === secondCharacterId) return true;
    const firstGroupId = getCharacterWorldGroupId(firstCharacterId);
    const secondGroupId = getCharacterWorldGroupId(secondCharacterId);
    return Boolean(firstGroupId && secondGroupId && firstGroupId === secondGroupId);
}

export function canCharacterSeeMomentPost(post: MomentPost, viewerCharacterId: string): boolean {
    if (post.authorType === "user") return post.visibility.includes(viewerCharacterId);
    if (post.authorId === viewerCharacterId) return true;
    return post.visibility.includes(viewerCharacterId) && areCharactersInSameWorld(post.authorId, viewerCharacterId);
}

export function isMomentRealCharacterAllowedForViewer(viewerCharacterId: string, targetCharacterId: string): boolean {
    return areCharactersInSameWorld(viewerCharacterId, targetCharacterId);
}

export function isMomentRealCharacterAllowedForPost(post: MomentPost, targetCharacterId: string, anchorCharacterId?: string): boolean {
    if (post.authorType === "character") {
        return areCharactersInSameWorld(post.authorId, targetCharacterId);
    }
    if (anchorCharacterId) {
        return areCharactersInSameWorld(anchorCharacterId, targetCharacterId);
    }
    return post.visibility.includes(targetCharacterId);
}

export function isMomentCommentVisibleToCharacter(post: MomentPost, comment: MomentComment, viewerCharacterId: string): boolean {
    if (!canCharacterSeeMomentPost(post, viewerCharacterId)) return false;

    if (comment.replyToAuthorType === "character" && comment.replyToAuthorId) {
        return areCharactersInSameWorld(viewerCharacterId, comment.replyToAuthorId);
    }

    if (comment.authorType === "user") return true;

    if (comment.authorType === "character" && !areCharactersInSameWorld(viewerCharacterId, comment.authorId)) {
        return false;
    }

    if (comment.authorType === "npc" && post.authorType === "character" && !areCharactersInSameWorld(viewerCharacterId, post.authorId)) {
        return false;
    }

    return true;
}

export function getVisibleMomentCommentsForCharacter(post: MomentPost, viewerCharacterId: string, comments: MomentComment[]): MomentComment[] {
    return comments.filter(comment => isMomentCommentVisibleToCharacter(post, comment, viewerCharacterId));
}

export function getVisibleMomentLikesForCharacter(post: MomentPost, viewerCharacterId: string, likes: MomentLike[]): MomentLike[] {
    if (!canCharacterSeeMomentPost(post, viewerCharacterId)) return [];
    return likes.filter(like => {
        if (like.authorType === "user") return true;
        if (like.authorType === "character") return areCharactersInSameWorld(viewerCharacterId, like.authorId);
        if (post.authorType === "character") return areCharactersInSameWorld(viewerCharacterId, post.authorId);
        return true;
    });
}

export type CharacterRelationPromptOptions = {
    mentionText?: string;
    /** Undefined resolves the character binding; [] explicitly means no user identity. */
    userIdentityIds?: string[];
    appId?: string;
    /** Participants whose card is managed separately, including intentionally disabled cards. */
    describedCharacterIds?: string[];
};

export function formatCharacterRelationsForPrompt(characterId: string, options: CharacterRelationPromptOptions = {}): string {
    return formatCharactersRelationsForPrompt([characterId], options);
}

/** One world section per request, regardless of how many participants share it. */
export function formatCharactersRelationsForPrompt(characterIds: string[], options: CharacterRelationPromptOptions = {}): string {
    const groups = loadCharacterWorldGroups();
    const characters = loadCharacters();
    const identities = loadUserIdentities();
    const activeIds = new Set(options.userIdentityIds ?? characterIds.flatMap(id => {
        const identity = resolveUserIdentity(id, options.appId);
        return identity ? [identity.id] : [];
    }));
    const activeIdentities = identities.filter(identity => activeIds.has(identity.id));
    const contactIds = new Set(loadChatContacts().map(contact => contact.characterId));
    const described = new Set(options.describedCharacterIds ?? characterIds);
    return groups.filter(group => characterIds.some(id => group.memberIds.includes(id))).map(group => {
        const worldDescription = group.description.trim();
        const hasWorldSetup = groups.length > 1 || group.id !== DEFAULT_CHARACTER_WORLD_ID || group.relations.length > 0 || Boolean(worldDescription);
        if (!hasWorldSetup) return "";

        const nodes = [...characters.filter(character => group.memberIds.includes(character.id)),
            ...activeIdentities.map(identity => ({ id: getCharacterWorldUserNodeId(identity.id), name: identity.name?.trim() || "用户" }))];
        const nameById = new Map(nodes.map(node => [node.id, node.name]));
        const selected = selectRelatedWorldRelations({ nodes, relations: group.relations,
            seedIds: [...characterIds, ...activeIdentities.map(identity => getCharacterWorldUserNodeId(identity.id))],
            mentionText: options.mentionText || "" });
        // 标注哪些同世界角色已是用户好友——供「推荐联系人」判断是否还需要发名片
        const memberNames = group.memberIds
            .filter(id => selected.includedIds.has(id))
            .map(memberId => {
                const name = nameById.get(memberId);
                if (!name) return null;
                return contactIds.has(memberId) ? `${name}（已是用户好友）` : name;
            })
            .filter((name): name is string => Boolean(name));

        const lines: string[] = [];
        lines.push(`当前世界观：${group.name}。`);
        if (worldDescription) {
            lines.push(`世界观描述：${worldDescription}`);
        }
        if (memberNames.length > 0 && (groups.length > 1 || group.id !== DEFAULT_CHARACTER_WORLD_ID || worldDescription)) {
            lines.push(`本轮相关的同世界角色：${memberNames.join("、")}。`);
        }

        for (const relation of selected.relations) {
            const fromName = nameById.get(relation.fromCharacterId);
            const toName = nameById.get(relation.toCharacterId);
            if (!fromName || !toName) continue;
            lines.push(`${fromName}是${toName}的${relation.label}。`);
        }

        for (const userIdentity of activeIdentities) {
            const currentUserNodeId = getCharacterWorldUserNodeId(userIdentity.id);
            if (selected.relations.some(relation => relation.fromCharacterId === currentUserNodeId || relation.toCharacterId === currentUserNodeId)) {
                const identityDetails = [
                    userIdentity.gender ? `性别：${userIdentity.gender}` : "",
                    userIdentity.age ? `年龄：${userIdentity.age}` : "",
                    userIdentity.occupation ? `职业：${userIdentity.occupation}` : "",
                    userIdentity.bio?.trim() ? `简介：${userIdentity.bio.trim()}` : "",
                    userIdentity.customSettings?.trim() ? `补充设定：${userIdentity.customSettings.trim()}` : "",
                ].filter(Boolean).join("；");
                lines.push(`当前用户身份节点：${userIdentity.name?.trim() || "用户"}${identityDetails ? `（${identityDetails}）` : ""}。`);
            }
        }

        // Existing briefs cover referenced/neighbour characters, without duplicating full participant cards.
        const characterById = new Map(characters.map(character => [character.id, character]));
        const briefLines: string[] = [];
        for (const counterpartId of selected.includedIds) {
            if (described.has(counterpartId)) continue;
            const counterpart = characterById.get(counterpartId);
            const brief = counterpart?.briefPersona?.trim();
            if (!counterpart || !brief) continue;
            briefLines.push(`- ${counterpart.name}：${brief.replace(/\{\{\s*char\s*\}\}/gi, () => counterpart.name)}`);
        }
        if (briefLines.length > 0) {
            lines.push("相关角色简介（供提及、转述或互动时参考）：");
            lines.push(...briefLines);
        }

        return lines.join("\n");
    }).filter(Boolean).join("\n\n");
}
