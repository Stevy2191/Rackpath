import React from 'react';
import { PROJECT_TEMPLATES } from '../project/templates';
import TemplatePreview from './TemplatePreview';
import './TemplatePicker.css';

// Card grid for the "Choose a starting template" step of the new project
// flow. `value` is the selected template key; `onChange` fires with the new
// key when a card is clicked.
export default function TemplatePicker({ value, onChange }) {
  return (
    <div className="template-picker">
      {PROJECT_TEMPLATES.map((template) => (
        <button
          key={template.key}
          type="button"
          className={`template-card${value === template.key ? ' selected' : ''}`}
          onClick={() => onChange(template.key)}
        >
          <TemplatePreview nodes={template.nodes} edges={template.edges} />
          <span className="template-card-name">{template.name}</span>
          <span className="template-card-description">{template.description}</span>
        </button>
      ))}
    </div>
  );
}
