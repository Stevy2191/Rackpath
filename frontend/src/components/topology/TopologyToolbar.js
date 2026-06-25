import React from 'react';
import {
  MousePointer2,
  Link as LinkIcon,
  Type,
  BoxSelect,
  Image,
  Shapes,
  Grid3X3,
  Map,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Undo2,
  Redo2,
  AlignLeft,
  AlignCenter,
  AlignRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
} from 'lucide-react';
import { SHAPE_TYPES } from './ShapeNode';
import './TopologyToolbar.css';

const MODES = [
  { id: 'select', label: 'Select', icon: MousePointer2, hint: 'Select and move nodes' },
  { id: 'link',   label: 'Link',   icon: LinkIcon,       hint: 'Drag from a port to create a link' },
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
  background,
  backgroundMenuOpen,
  onToggleBackgroundMenu,
  onBackgroundChange,
  showEdgeLabels,
  onToggleEdgeLabels,
  showGrid,
  onToggleGrid,
  showMinimap,
  onToggleMinimap,
  onSave,
  onExport,
  exporting,
  exportMenuOpen,
  onToggleExportMenu,
  onClearCanvas,
  onFitView,
  onZoomIn,
  onZoomOut,
  onAutoLayout,
  onUndo,
  onRedo,
  onAlign,
  onDistribute,
  selectedCount = 0,
}) {
  const canAlign = selectedCount >= 2;
  const canDistribute = selectedCount >= 3;

  return (
    <div className="topology-toolbar">
      {/* ── Mode buttons ──────────────────────────────────── */}
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

        {/* Shape submenu */}
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
                  onClick={() => { onShapeTypeChange(id); onModeChange('shape'); }}
                >
                  {SHAPE_ICONS[id]} {label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Background submenu */}
        <div className="topology-toolbar-popover-anchor">
          <button
            type="button"
            className={`topology-mode-btn${backgroundMenuOpen ? ' active' : ''}`}
            onClick={onToggleBackgroundMenu}
            title="Canvas background"
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

      {/* ── View controls ─────────────────────────────────── */}
      <div className="topology-toolbar-view">
        <button type="button" className="topology-icon-btn" onClick={onZoomIn}  title="Zoom in (Ctrl+)"><ZoomIn  size={15} /></button>
        <button type="button" className="topology-icon-btn" onClick={onZoomOut} title="Zoom out (Ctrl-)"><ZoomOut size={15} /></button>
        <button type="button" className="topology-icon-btn" onClick={onFitView}     title="Fit to screen (Ctrl+Shift+F)"><Maximize2 size={15} /></button>
        <button type="button" className={`topology-icon-btn${showGrid ? ' active' : ''}`}    onClick={onToggleGrid}    title="Toggle grid"><Grid3X3 size={15} /></button>
        <button type="button" className={`topology-icon-btn${showMinimap ? ' active' : ''}`} onClick={onToggleMinimap} title="Toggle minimap"><Map size={15} /></button>
      </div>

      {/* ── Align / Distribute (shown when ≥2 nodes selected) */}
      {canAlign && (
        <div className="topology-toolbar-align">
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('left')}   title="Align left"><AlignLeft           size={15} /></button>
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('center')} title="Align center"><AlignCenter        size={15} /></button>
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('right')}  title="Align right"><AlignRight          size={15} /></button>
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('top')}    title="Align top"><AlignStartVertical    size={15} /></button>
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('middle')} title="Align middle"><AlignCenterVertical size={15} /></button>
          <button type="button" className="topology-icon-btn" onClick={() => onAlign('bottom')} title="Align bottom"><AlignEndVertical    size={15} /></button>
          {canDistribute && (
            <>
              <button type="button" className="topology-icon-btn" onClick={() => onDistribute('horizontal')} title="Distribute horizontally">⇔</button>
              <button type="button" className="topology-icon-btn" onClick={() => onDistribute('vertical')}   title="Distribute vertically">⇕</button>
            </>
          )}
        </div>
      )}

      {/* ── Actions ───────────────────────────────────────── */}
      <div className="topology-toolbar-actions">
        <button type="button" className="topology-icon-btn" onClick={onUndo} title="Undo (Ctrl+Z)"><Undo2 size={15} /></button>
        <button type="button" className="topology-icon-btn" onClick={onRedo} title="Redo (Ctrl+Shift+Z)"><Redo2 size={15} /></button>

        <div className="topology-toolbar-sep" />

        <label className="topology-toggle">
          <input type="checkbox" checked={showEdgeLabels} onChange={onToggleEdgeLabels} />
          Edge labels
        </label>

        <button type="button" onClick={onAutoLayout}>Auto Layout</button>
        <button type="button" onClick={onSave}>Save</button>

        <div className="topology-toolbar-popover-anchor">
          <button type="button" onClick={onToggleExportMenu} disabled={exporting}>
            {exporting ? 'Exporting…' : 'Export ▾'}
          </button>
          {exportMenuOpen && (
            <div className="topology-toolbar-menu">
              <button type="button" onClick={() => onExport('png')}>Export as PNG</button>
              <button type="button" onClick={() => onExport('svg')}>Export as SVG</button>
              <button type="button" onClick={() => onExport('pdf')}>Export as PDF</button>
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
