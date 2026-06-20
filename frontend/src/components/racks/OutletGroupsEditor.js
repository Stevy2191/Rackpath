import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { OUTLET_TYPES } from './deviceFieldSchemas';

// A select of preset type strings plus an "Other…" option that reveals a
// free-text input. customMode is tracked explicitly (not just inferred from
// whether the current value matches a preset) so picking "Other…" always
// works, even before any custom text has been typed.
export function TypeSelect({ value, presets, onChange, placeholder }) {
  const isPreset = presets.includes(value);
  const [customMode, setCustomMode] = useState(Boolean(value) && !isPreset);
  const showCustomInput = customMode || (Boolean(value) && !isPreset);

  return (
    <>
      <select
        className="props-input"
        value={showCustomInput ? 'Other' : (value || presets[0])}
        onChange={(e) => {
          if (e.target.value === 'Other') { setCustomMode(true); return; }
          setCustomMode(false);
          onChange(e.target.value);
        }}
      >
        {presets.map((t) => <option key={t} value={t}>{t}</option>)}
        <option value="Other">Other…</option>
      </select>
      {showCustomInput && (
        <input
          className="props-input"
          style={{ marginTop: 4 }}
          value={isPreset ? '' : (value || '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      )}
    </>
  );
}

// Editable list of {type, count} outlet groups — replaces a single flat
// outlet count + type so mixed-outlet units (e.g. 6x NEMA 5-15R + 2x C19)
// can be modeled accurately. `groups` and `onChange` are controlled —
// every add/remove/edit calls onChange with the full next array.
export default function OutletGroupsEditor({ groups, onChange }) {
  const list = Array.isArray(groups) ? groups : [];

  const updateGroup = (index, changes) => {
    onChange(list.map((g, i) => (i === index ? { ...g, ...changes } : g)));
  };
  const removeGroup = (index) => {
    onChange(list.filter((_, i) => i !== index));
  };
  const addGroup = () => {
    onChange([...list, { type: OUTLET_TYPES[0], count: 1 }]);
  };

  return (
    <div className="props-outlet-groups">
      {list.length === 0 && <p className="props-empty-note">No outlet groups defined.</p>}
      {list.map((group, i) => (
        <div key={i} className="props-outlet-group-row">
          <div className="props-outlet-group-type">
            <TypeSelect
              value={group.type}
              presets={OUTLET_TYPES}
              onChange={(type) => updateGroup(i, { type })}
              placeholder="Custom outlet type"
            />
          </div>
          <input
            className="props-input props-outlet-group-count"
            type="number"
            min="1"
            value={group.count}
            onChange={(e) => updateGroup(i, { count: Math.max(1, Number(e.target.value) || 1) })}
          />
          <button type="button" className="props-outlet-group-remove" title="Remove" onClick={() => removeGroup(i)}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="props-upload-btn" onClick={addGroup}>
        <Plus size={12} /> Add Outlet Group
      </button>
    </div>
  );
}
