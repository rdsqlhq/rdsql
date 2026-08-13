import React, { useState } from 'react';
import { X, Tag as TagIcon, Plus } from 'lucide-react';
import { useEscapeToClose } from '../../core/hooks/useEscapeToClose';
import { useTagStore } from '../../store/useTagStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useStorageStore } from '../../store/useStorageStore';
import { TAG_COLOR_PRESETS, isValidTagLabel, hexToRgba } from '../../core/domain/tags';

/**
 * Tiny modal for creating a custom tag. The user picks a label and a color
 * (from presets or a native color input), then Create adds it to the tag store
 * and invokes `onCreated` with the new tag id so the caller (e.g. the Edit
 * Connection form or the Explorer context menu) can immediately assign it to a
 * connection.
 */
export const CreateTagModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  /** If provided, the new tag is immediately assigned to this connection. */
  assignToConnectionId?: string | null;
  onCreated?: (tagId: string) => void;
}> = ({ isOpen, onClose, assignToConnectionId, onCreated }) => {
  const { addTag } = useTagStore();
  const { setConnectionTag } = useConnectionStore();
  const setStorageConnectionTag = useStorageStore((s) => s.setConnectionTag);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(TAG_COLOR_PRESETS[6]); // violet default
  const [error, setError] = useState<string | null>(null);
  useEscapeToClose(isOpen ? onClose : null);

  if (!isOpen) return null;

  const reset = () => {
    setLabel('');
    setColor(TAG_COLOR_PRESETS[6]);
    setError(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleCreate = () => {
    if (!isValidTagLabel(label)) {
      setError('Enter a tag name (1–24 characters).');
      return;
    }
    const tag = addTag(label, color);
    if (assignToConnectionId) {
      // Storage connection ids start with `stor_`; DB connection ids with
      // `conn_`. Route the tag assignment to the correct store so tags created
      // from the storage context menu are applied to the right connection.
      if (assignToConnectionId.startsWith('stor_')) {
        setStorageConnectionTag(assignToConnectionId, tag.id);
      } else {
        setConnectionTag(assignToConnectionId, tag.id);
      }
    }
    onCreated?.(tag.id);
    reset();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={handleClose}
    >
      <div
        className="w-full max-w-sm bg-[#0a0f18] border border-[#1e293b] rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b]">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-200">
            <TagIcon className="w-4 h-4 text-blue-400" />
            New Tag
          </div>
          <button onClick={handleClose} className="text-slate-500 hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Label */}
          <div className="space-y-1.5">
            <label className="block text-[11px] text-slate-500 font-semibold">Name</label>
            <input
              type="text"
              autoFocus
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="e.g. Sandbox, QA, Preview"
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              className="w-full bg-[#06090e] border border-[#1e293b] rounded-lg text-sm text-slate-200 px-3 py-2 focus:outline-none focus:border-blue-500/50"
            />
          </div>

          {/* Color */}
          <div className="space-y-1.5">
            <label className="block text-[11px] text-slate-500 font-semibold">Color</label>
            <div className="flex flex-wrap items-center gap-1.5">
              {TAG_COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`w-6 h-6 rounded-full border-2 transition-transform hover:scale-110 ${
                    color.toLowerCase() === c.toLowerCase() ? 'border-white scale-110' : 'border-transparent'
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
              {/* Native color picker for custom hex */}
              <label
                className="w-6 h-6 rounded-full border-2 border-dashed border-[#1e293b] hover:border-blue-500/50 flex items-center justify-center cursor-pointer overflow-hidden relative"
                title="Custom color"
              >
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <Plus className="w-3 h-3 text-slate-500" />
              </label>
            </div>
          </div>

          {/* Live preview */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-slate-600">Preview:</span>
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: hexToRgba(color, 0.15), color }}
            >
              {(label.trim() || 'YOUR TAG').toUpperCase()}
            </span>
          </div>

          {error && (
            <div className="text-[11px] text-rose-400">{error}</div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={handleClose}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!isValidTagLabel(label)}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus className="w-3.5 h-3.5" />
              Create Tag
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
