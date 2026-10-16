import type { CharacterWorldRelation } from "./character-world-storage";

/** Activation uses authored scene material, never the relation output or character cards. */
export function buildRelationMentionContext(history: string[], related: string[] = []): string {
    return [history.slice(-24).map(text => text.slice(-4000)).join("\n").slice(-48000),
        related.filter(Boolean).join("\n").slice(-16000)].filter(Boolean).join("\n");
}

export function selectRelatedWorldRelations(options: {
    nodes: { id: string; name: string }[];
    relations: CharacterWorldRelation[];
    seedIds: string[];
    mentionText: string;
}) {
    const valid = new Set(options.nodes.map(node => node.id));
    const seeds = new Set(options.seedIds.filter(id => valid.has(id)));
    const byName = new Map<string, string[]>();
    for (const node of options.nodes) {
        const name = node.name.trim();
        if (name.length < 2) continue;
        byName.set(name, [...(byName.get(name) || []), node.id]);
    }
    for (const [name, ids] of byName) {
        if (ids.length !== 1) continue;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Avoid matching Ann inside Anna. CJK names commonly adjoin ordinary prose.
        const pattern = /^[\p{Script=Latin}\d _.'-]+$/u.test(name)
            ? `(?<![\\p{Script=Latin}\\d_])${escaped}(?![\\p{Script=Latin}\\d_])` : escaped;
        if (new RegExp(pattern, "iu").test(options.mentionText)) seeds.add(ids[0]);
    }
    const included = new Set(seeds);
    const seen = new Set<string>();
    const relations = options.relations.filter(relation => {
        const { fromCharacterId: from, toCharacterId: to } = relation;
        if (!valid.has(from) || !valid.has(to) || (!seeds.has(from) && !seeds.has(to))) return false;
        const key = JSON.stringify([from, to, relation.label.trim()]);
        if (seen.has(key)) return false;
        seen.add(key);
        included.add(from); included.add(to);
        return true;
    });
    return { relations, includedIds: included };
}
