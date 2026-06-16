import React from 'react';
import { MousePointer2, Link as LinkIcon, Type, BoxSelect, Calculator, Image, Shapes } from 'lucide-react';
import { SHAPE_TYPES } from './ShapeNode';
import './TopologyToolbar.css';

const MODES = [
  { id: 'select', label: 'Select', icon: MousePointer2, hint: 'Select and move nodes' },
  { id: 'link',   label: 'Link',   icon: LinkIcon,       hint: 'Click a node, then another, to connect' },
  { id: 'text',   label: 'Text',   icon: Type,           hint: 'Click the canvas to add a text label' },
  { id: 'zone',   label: 'Zone',   icon: BoxSelect,      hint: 'Click the canvas to add a zone' },
];

const BACKGROUNDS = [
  { id: 'dots',  label: 'Dot grid' },
  { id: 'lines', label: 'Lines'    },
  { id: 'solid', label: 'Solid'    },
  { id: 'none',  label: 'None'     },
];

const SHAPE_ICONS = {
  rect:          '▭',
  circle:        '◯',
  diamond:       '◇',
  hexagon:       '⬡',
  cylinder:      '⬭',
  parallelogram: '▱',
};

export default function TopologyToolbar({
  mode,
  onModeChange,
  shapeType,
  onShapeTypeChange,
  shapeMenuOpen,
  onToggleShapeMenu,
  calcOpen,
  onToggleCalc,
  background,
  backgroundMenuOpen,
  onToggleBackgroundMenu,
  onBackgroundChange,
  showEdgeLabels,
  onToggleEdgeLabels,
  onSave,
  onExport,
  exporting,
  exportMenuOpen,
  onToggleExportMenu,
  onClearCanvas,
}) {
  return (
    <div className="topology-toolbar">
      <div className="topology-toolbar-modes">
        {MODES.map(({ id, label, icon: Icon, hint }) => (
          <button
            key={id}
            type="button"
            className={`topology-mode-btn${mode === id ? ' active' : ''}`}
            onClick={() => onModeChange(id)}
            title={hint}
            aria-pressed={mode === id}
          >
            <Icon size={16} strokeWidth={2} />
            <span>{label}</span>
          </button>
        ))}

        {/* Shape button with type submenu */}
        <div className="topology-toolbar-popover-anchor">
          <button
            type="button"
            className={`topology-mode-btn${mode === 'shape' ? ' active' : ''}`}
            onClick={onToggleShapeMenu}
            title="Click the canvas to add a shape"
            aria-pressed={mode === 'shape'}
          >
            <Shapes size={16} strokeWidth={2} />
            <span>Shape{mode === 'shape' ? ` · ${SHAPE_ICONS[shapeType] || '▭'}` : ''} ▾</span>
          </button>
          {shapeMenuOpen && (
            <div className="topology-toolbar-menu">
              {SHAPE_TYPES.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={shapeType === id ? 'selected' : ''}
                  onClick={() => {
                    onShapeTypeChange(id);
                    onModeChange('shape');
                  }}
                >
                  {SHAPE_ICONS[id]} {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={`topology-mode-btn${calcOpen ? ' active' : ''}`}
          onClick={onToggleCalc}
          title="Subnet calculator"
          aria-pressed={calcOpen}
        >
          <Calculator size={16} strokeWidth={2} />
          <span>Calc</span>
        </button>

        <div className="topology-toolbar-popover-anchor">
          <button
            type="button"
            className={`topology-mode-btn${backgroundMenuOpen ? ' active' : ''}`}
            onClick={onToggleBackgroundMenu}
            title="Canvas background"
            aria-pressed={backgroundMenuOpen}
          >
            <Image size={16} strokeWidth={2} />
            <span>Background</span>
          </button>
          {backgroundMenuOpen && (
            <div className="topology-toolbar-menu">
              {BACKGROUNDS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className={background === id ? 'selected' : ''}
                  onClick={() => onBackgroundChange(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="topology-toolbar-actions">
        <label className="topology-toggle">
          <input type="checkbox" checked={showEdgeLabels} onChange={onToggleEdgeLabels} />
          Edge labels
        </label>
        <button type="button" onClick={onSave}>
          Save
        </button>
        <div className="topology-toolbar-popover-anchor">
          <button type="button" onClick={onToggleExportMenu} disabled={exporting}>
            {exporting ? 'Exporting...' : 'Export ▾'}
          </button>
          {exportMenuOpen && (
            <div className="topology-toolbar-menu">
              <button type="button" onClick={() => onExport('png')}>
                Export as PNG
              </button>
              <button type="button" onClick={() => onExport('svg')}>
                Export as SVG
              </button>
              <button type="button" onClick={() => onExport('pdf')}>
                Export as PDF
              </button>
            </div>
          )}
        </div>
        <button type="button" className="topology-danger-button" onClick={onClearCanvas}>
          Clear Canvas
        </button>
      </div>
    </div>
  );
}
