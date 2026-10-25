"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { moveCharactersToWorld, type CharacterWorldGroup } from "@/lib/character-world-storage";

export function WorldTransferSheet({ characters, groups, sourceId, onClose, onNotice }: {
  characters: Character[];
  groups: CharacterWorldGroup[];
  sourceId: string;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState("");
  const source = groups.find(group => group.id === sourceId);
  const candidates = characters.filter(character => source?.memberIds.includes(character.id));
  const targets = groups.filter(group => group.id !== sourceId);
  const transfer = () => {
    try {
      if (selected.some(id => !candidates.some(character => character.id === id))) {
        throw new Error("角色列表已变化，请关闭面板后重新选择。");
      }
      moveCharactersToWorld(selected, targetId);
      onNotice(`已转移 ${selected.length} 个角色，同行角色之间的关系已保留。`);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转移失败，请重试。");
    }
  };
  return (
    <div className="modal-overlay modal-overlay-bottom" data-ui="modal">
      <div className="modal-sheet" data-ui="modal-sheet" role="dialog" aria-modal="true" aria-labelledby="world-transfer-title">
        <div className="modal-header" data-ui="modal-header">
          <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="取消转移" onClick={onClose}><X size={18} /></button>
          <span className="modal-header-title" id="world-transfer-title">批量转移角色</span>
        </div>
        <div className="modal-body hide-scrollbar flex flex-col gap-3 pb-8" data-ui="modal-body">
          <p className="menu-desc">同行角色之间的关系会一起转移；与留在原世界的角色及用户身份的关系会清理。</p>
          <label className="menu-label" htmlFor="world-transfer-target">目标世界</label>
          <select id="world-transfer-target" className="ui-input w-full" value={targetId} onChange={event => setTargetId(event.target.value)}>
            <option value="">请选择目标世界</option>
            {targets.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          {!targets.length && <p className="menu-desc">请先建立另一个世界。</p>}
          <div className="flex items-center justify-between">
            <span className="menu-label">{source?.name ?? "原世界"} · 已选 {selected.length} 人</span>
            <button type="button" className="ui-btn ui-btn-outline" onClick={() => setSelected(candidates.every(c => selected.includes(c.id)) ? [] : candidates.map(c => c.id))}>
              {candidates.length > 0 && candidates.every(c => selected.includes(c.id)) ? "取消全选" : "全选"}
            </button>
          </div>
          {candidates.map(character => (
            <label key={character.id} className="flex items-center gap-3 rounded-2xl border border-[var(--c-card-border)] bg-[var(--c-input)] p-3">
              <input type="checkbox" checked={selected.includes(character.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, character.id] : ids.filter(id => id !== character.id))} />
              <span className="menu-label">{character.name || "未命名角色"}</span>
            </label>
          ))}
          {!candidates.length && <p className="menu-desc">当前世界没有可转移的角色。</p>}
          {error && <p role="alert" className="menu-desc text-red-600">{error}</p>}
        </div>
        <div className="modal-footer" data-ui="modal-footer">
          <button type="button" className="ui-btn ui-btn-primary w-full" disabled={!selected.length || !targets.some(group => group.id === targetId)} onClick={transfer}>确认转移 {selected.length} 个角色</button>
        </div>
      </div>
    </div>
  );
}
