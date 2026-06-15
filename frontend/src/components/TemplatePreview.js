import React from 'react';

const VIEW_BOX = '0 0 120 90';

// Mini "circles connected by lines" diagram showing a template's rough
// topology shape. An empty `nodes` array (the Blank Canvas template) renders
// a plain empty-canvas placeholder instead.
export default function TemplatePreview({ nodes, edges }) {
  if (!nodes || nodes.length === 0) {
    return (
      <svg viewBox={VIEW_BOX} className="template-preview template-preview-blank" aria-hidden="true">
        <rect x="10" y="10" width="100" height="70" rx="6" />
        <line x1="60" y1="32" x2="60" y2="58" />
        <line x1="47" y1="45" x2="73" y2="45" />
      </svg>
    );
  }

  return (
    <svg viewBox={VIEW_BOX} className="template-preview" aria-hidden="true">
      {edges.map(([a, b], i) => {
        const from = nodes[a];
        const to = nodes[b];
        return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
      })}
      {nodes.map((n, i) => (
        <circle key={i} cx={n.x} cy={n.y} r="6" />
      ))}
    </svg>
  );
}
