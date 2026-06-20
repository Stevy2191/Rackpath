import React, { useState } from 'react';

const CUSTOM_OPTION = '__custom__';

function ConfigField({ field, value, onChange }) {
  // Whether the custom-count input is showing. Starts true if the current
  // value isn't one of the presets (e.g. a previously-saved custom count);
  // tracked as its own state so picking "Custom…" works even when the
  // current value happens to already match a preset.
  const isPreset = field.options && (field.options.includes(Number(value)) || field.options.includes(value));
  const [customMode, setCustomMode] = useState(field.kind === 'select' && field.allowCustom && !isPreset);

  if (field.kind === 'select') {
    const showCustomInput = customMode || !isPreset;
    return (
      <div className="props-field">
        <label className="props-field-label">{field.label}</label>
        {field.allowCustom ? (
          <>
            <select
              className="props-input"
              value={showCustomInput ? CUSTOM_OPTION : String(value)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === CUSTOM_OPTION) {
                  setCustomMode(true);
                  return;
                }
                setCustomMode(false);
                onChange(Number(v) || v);
              }}
            >
              {field.options.map((opt) => (
                <option key={opt} value={opt}>{opt}{typeof opt === 'number' ? '-port' : ''}</option>
              ))}
              <option value={CUSTOM_OPTION}>Custom…</option>
            </select>
            {showCustomInput && (
              <input
                className="props-input"
                type="number"
                min="1"
                value={value || ''}
                onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
                placeholder="Custom count"
                style={{ marginTop: 6 }}
              />
            )}
          </>
        ) : (
          <select className="props-input" value={value || ''} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        )}
      </div>
    );
  }
  return (
    <div className="props-field">
      <label className="props-field-label">{field.label}</label>
      <input
        className="props-input"
        type="number"
        min={field.min}
        max={field.max}
        step={field.step || 1}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    </div>
  );
}

// Renders the type-specific configurable fields (port count, bay count,
// outlet spec, UPS capacity, ...) for a device's renderType schema. Shared
// between QuickConfigModal (at placement time) and DevicePropertiesPanel
// (afterwards) so both stay in sync.
export default function DeviceConfigFields({ schema, values, onChange }) {
  if (schema.length === 0) return null;
  return (
    <>
      {schema.map((field) => (
        <ConfigField
          key={field.key}
          field={field}
          value={values[field.key]}
          onChange={(val) => onChange(field.key, val)}
        />
      ))}
    </>
  );
}
