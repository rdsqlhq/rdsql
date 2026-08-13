import React from 'react';

/** A labeled on/off switch with a one-line description. Used for boolean
 *  preferences in the Settings view. */
export const Toggle: React.FC<{
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, description, checked, onChange }) => (
  <label className="flex items-start justify-between gap-3 py-2 cursor-pointer select-none group">
    <div className="min-w-0">
      <div className="text-slate-200 group-hover:text-white transition-colors">{label}</div>
      {description && (
        <div className="text-[10px] text-slate-600 mt-0.5 leading-relaxed">{description}</div>
      )}
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${
        checked ? 'bg-blue-600' : 'bg-[#1e293b]'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  </label>
);
