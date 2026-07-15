import React, {
  forwardRef,
  useImperativeHandle,
  useEffect,
  useRef,
  useCallback,
} from 'react';
import { Graph, Edge } from '@antv/x6';
import { register } from '@antv/x6-react-shape';
import { Selection } from '@antv/x6-plugin-selection';
import { Snapline } from '@antv/x6-plugin-snapline';
import { Keyboard } from '@antv/x6-plugin-keyboard';
import { Clipboard } from '@antv/x6-plugin-clipboard';
import { History } from '@antv/x6-plugin-history';
import { MiniMap } from '@antv/x6-plugin-minimap';
import { Scroller } from '@antv/x6-plugin-scroller';
import { TopologyGraphContext } from './TopologyGraphContext';
import { useTheme } from '../../theme/ThemeContext';
import DeviceCell from './x6cells/DeviceCell';
import ZoneCell from './x6cells/ZoneCell';
import ShapeCell from './x6cells/ShapeCell';
import TextCell from './x6cells/TextCell';
import { MANUAL_DRAG_TYPE, DISCOVERED_DRAG_TYPE } from './DevicePicker';
import './X6Canvas.css';

// ── Port group shared by all node shapes ──────────────────────────────────────
const PORT_GROUPS = {
  top:    { position: 'top',    attrs: { circle: { r: 5, magnet: true, stroke: 'var(--color-accent)', strokeWidth: 2, fill: 'var(--color-bg-elevated)', opacity: 0 } } },
  bottom: { position: 'bottom', attrs: { circle: { r: 5, magnet: true, stroke: 'var(--color-accent)', strokeWidth: 2, fill: 'var(--color-bg-elevated)', opacity: 0 } } },
  left:   { position: 'left',   attrs: { circle: { r: 5, magnet: true, stroke: 'var(--color-accent)', strokeWidth: 2, fill: 'var(--color-bg-elevated)', opacity: 0 } } },
  right:  { position: 'right',  attrs: { circle: { r: 5, magnet: true, stroke: 'var(--color-accent)', strokeWidth: 2, fill: 'var(--color-bg-elevated)', opacity: 0 } } },
};

// Resolve theme CSS variables to concrete values for X6 APIs that rasterise
// colors (canvas background, grid pattern) and can't consume var() references.
function themeCanvasColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: styles.getPropertyValue('--color-bg').trim() || '#f4f5f7',
    grid: styles.getPropertyValue('--color-canvas-grid').trim() || 'rgba(128,128,128,0.25)',
  };
}

const PORT_ITEMS = [
  { id: 'top',    group: 'top'    },
  { id: 'bottom', group: 'bottom' },
  { id: 'left',   group: 'left'   },
  { id: 'right',  group: 'right'  },
];

const SILENT_BODY = {
  attrs: { body: { fill: 'transparent', stroke: 'none', pointerEvents: 'none' } },
};

// Register all shapes once (module-level flag prevents double-registration)
let shapesReady = false;
function ensureShapes() {
  if (shapesReady) return;
  shapesReady = true;

  register({
    shape: 'device-node',
    width: 120,
    height: 80,
    component: DeviceCell,
    ...SILENT_BODY,
    ports: { groups: PORT_GROUPS, items: PORT_ITEMS },
  });

  register({
    shape: 'zone-node',
    width: 320,
    height: 220,
    component: ZoneCell,
    ...SILENT_BODY,
    ports: { groups: PORT_GROUPS, items: PORT_ITEMS },
    zIndex: 0,
  });

  register({
    shape: 'shape-node',
    width: 160,
    height: 100,
    component: ShapeCell,
    ...SILENT_BODY,
    ports: { groups: PORT_GROUPS, items: PORT_ITEMS },
  });

  register({
    shape: 'text-node',
    width: 140,
    height: 30,
    component: TextCell,
    ...SILENT_BODY,
    ports: { groups: PORT_GROUPS, items: PORT_ITEMS },
  });
}

// ── Edge attribute helpers ────────────────────────────────────────────────────
function dashArray(lineStyle) {
  if (lineStyle === 'dashed' || lineStyle === 'animated') return '8 4';
  return null;
}

function edgeConnector(pathStyle) {
  if (pathStyle === 'straight') return { name: 'straight' };
  if (pathStyle === 'orthogonal') return { name: 'rounded', args: { radius: 8 } };
  return { name: 'smooth' };
}

function edgeRouter(pathStyle) {
  if (pathStyle === 'orthogonal') return { name: 'orth' };
  return null;
}

function buildEdgeAttrs(data) {
  const stroke = data.label_color || 'var(--color-text-muted)';
  const da = dashArray(data.line_style);
  const animated = data.line_style === 'animated';
  return {
    line: {
      stroke,
      strokeWidth: 2,
      ...(da ? { strokeDasharray: da } : {}),
      ...(animated ? { style: { animation: 'x6-edge-flow 1s linear infinite' } } : {}),
      targetMarker: { name: 'block', width: 8, height: 5 },
    },
  };
}

function buildEdgeLabels(data, showLabels) {
  const labels = [];
  if (showLabels && data.label) {
    labels.push({
      position: 0.5,
      attrs: {
        text: { text: data.label, fill: data.label_color || 'var(--color-text)', fontSize: 11 },
        rect: { fill: 'var(--color-bg)', rx: 2, ry: 2 },
      },
    });
  }
  if (data.source_interface && showLabels) {
    labels.push({
      position: 0.12,
      attrs: {
        text: { text: data.source_interface, fill: data.label_color || 'var(--color-text-muted)', fontSize: 10 },
        rect: { fill: 'var(--color-bg)', rx: 2, ry: 2 },
      },
    });
  }
  if (data.target_interface && showLabels) {
    labels.push({
      position: 0.88,
      attrs: {
        text: { text: data.target_interface, fill: data.label_color || 'var(--color-text-muted)', fontSize: 10 },
        rect: { fill: 'var(--color-bg)', rx: 2, ry: 2 },
      },
    });
  }
  return labels;
}

function cellIdPrefix(elementType) {
  if (elementType === 'shape') return 'shape';
  if (elementType === 'zone') return 'zone';
  if (elementType === 'label') return 'label';
  return 'device';
}

// ── X6Canvas ──────────────────────────────────────────────────────────────────
const X6Canvas = forwardRef(function X6Canvas(props, ref) {
  const {
    contextValue,
    background,
    showGrid,
    showMinimap,
    mode,
    onNodeSelect,
    onEdgeSelect,
    onSelectionClear,
    onEdgePendingConnect,
    onNodeDeleted,
    onEdgeDeleted,
    onNodeMoved,
    onNodeResized,
    onEdgeVertexChanged,
    onDrop,
  } = props;

  const { theme } = useTheme();
  const containerRef = useRef(null);
  const minimapRef = useRef(null);
  const graphRef = useRef(null);
  const showLabelsRef = useRef(true);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const showGridRef = useRef(showGrid);
  showGridRef.current = showGrid;

  // ── Imperative API exposed to parent ────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    getGraph: () => graphRef.current,

    loadGraph(nodes, edges, showLabels) {
      const g = graphRef.current;
      if (!g) return;
      showLabelsRef.current = showLabels ?? true;
      g.clearCells();
      // Add zones first (z-index 0), then shapes and devices on top
      const sorted = [...nodes].sort((a, b) => {
        const order = { zone: 0, shape: 1, device: 2, label: 3 };
        return (order[a._cellType] ?? 2) - (order[b._cellType] ?? 2);
      });
      sorted.forEach((n) => this.addNode(n));
      edges.forEach((e) => this.addEdge(e, showLabels));
    },

    addNode(nodeData) {
      const g = graphRef.current;
      if (!g) return null;
      const shape = nodeData._cellType === 'zone' ? 'zone-node'
        : nodeData._cellType === 'shape' ? 'shape-node'
        : nodeData._cellType === 'label' ? 'text-node'
        : 'device-node';

      return g.addNode({
        id: nodeData._rfId,
        shape,
        x: nodeData.x,
        y: nodeData.y,
        width: nodeData.width || (nodeData._cellType === 'label' ? 140 : 120),
        height: nodeData.height || (nodeData._cellType === 'label' ? 30 : 80),
        resizable: nodeData._cellType !== 'label',
        data: nodeData,
        zIndex: nodeData._cellType === 'zone' ? 0 : nodeData._cellType === 'shape' ? 1 : 2,
      });
    },

    removeNode(rfId) {
      const g = graphRef.current;
      const cell = g?.getCellById(rfId);
      if (cell) g.removeCell(cell);
    },

    addEdge(edgeData, showLabels) {
      const g = graphRef.current;
      if (!g) return null;
      const sl = showLabels ?? showLabelsRef.current;
      const src = `${cellIdPrefix(edgeData.source_element_type)}-${edgeData.source_node_id}`;
      const tgt = `${cellIdPrefix(edgeData.target_element_type)}-${edgeData.target_node_id}`;
      const vertices = edgeData.waypoint_x != null
        ? [{ x: edgeData.waypoint_x, y: edgeData.waypoint_y }]
        : [];
      return g.addEdge({
        id: `edge-${edgeData.id}`,
        source: { cell: src, port: edgeData.source_handle || 'right' },
        target: { cell: tgt, port: edgeData.target_handle || 'left' },
        connector: edgeConnector(edgeData.path_style),
        router: edgeRouter(edgeData.path_style) || undefined,
        vertices,
        labels: buildEdgeLabels(edgeData, sl),
        attrs: buildEdgeAttrs(edgeData),
        data: edgeData,
        zIndex: 3,
      });
    },

    removeEdge(rfId) {
      const g = graphRef.current;
      const cell = g?.getCellById(rfId);
      if (cell) g.removeCell(cell);
    },

    updateEdge(rfId, dbData, showLabels) {
      const g = graphRef.current;
      const edge = g?.getCellById(rfId);
      if (!edge) return;
      const sl = showLabels ?? showLabelsRef.current;
      edge.setData(dbData);
      edge.setLabels(buildEdgeLabels(dbData, sl));
      edge.setAttrByPath('line/stroke', dbData.label_color || 'var(--color-text-muted)');
      const da = dashArray(dbData.line_style);
      edge.setAttrByPath('line/strokeDasharray', da || '');
      const conn = edgeConnector(dbData.path_style);
      edge.setConnector(conn);
      const router = edgeRouter(dbData.path_style);
      if (router) edge.setRouter(router);
    },

    updateNode(rfId, dataPatch) {
      const g = graphRef.current;
      const node = g?.getCellById(rfId);
      if (!node) return;
      node.setData({ ...node.getData(), ...dataPatch });
    },

    finalizeEdge(tempEdge, dbData, showLabels) {
      const sl = showLabels ?? showLabelsRef.current;
      tempEdge.setId(`edge-${dbData.id}`);
      tempEdge.setData(dbData);
      tempEdge.setLabels(buildEdgeLabels(dbData, sl));
      tempEdge.setAttrByPath('line/stroke', dbData.label_color || 'var(--color-text-muted)');
      tempEdge.setConnector(edgeConnector(dbData.path_style));
      const router = edgeRouter(dbData.path_style);
      if (router) tempEdge.setRouter(router);
    },

    setShowLabels(show) {
      showLabelsRef.current = show;
      const g = graphRef.current;
      if (!g) return;
      g.getEdges().forEach((edge) => {
        const data = edge.getData() || {};
        edge.setLabels(buildEdgeLabels(data, show));
      });
    },

    fitView() {
      graphRef.current?.fitToContent({ padding: 60, minScale: 0.3, maxScale: 2 });
    },

    zoomIn() { graphRef.current?.zoom(0.1); },
    zoomOut() { graphRef.current?.zoom(-0.1); },
    zoomTo(scale) { graphRef.current?.zoomTo(scale); },
    getZoom() { return graphRef.current?.zoom() ?? 1; },

    undo() { graphRef.current?.undo(); },
    redo() { graphRef.current?.redo(); },
    canUndo() { return graphRef.current?.canUndo() ?? false; },
    canRedo() { return graphRef.current?.canRedo() ?? false; },

    selectAll() {
      graphRef.current?.getNodes().forEach((n) => n.setSelected(true));
    },
    clearSelection() {
      graphRef.current?.cleanSelection();
    },

    getSelectedNodes() {
      return graphRef.current?.getSelectedCells().filter((c) => c.isNode()) ?? [];
    },

    groupSelected() {
      const g = graphRef.current;
      if (!g) return;
      const selected = g.getSelectedCells().filter((c) => c.isNode());
      if (selected.length < 2) return;
      g.resetSelection();
    },

    toDataUrl(type = 'png') {
      const g = graphRef.current;
      if (!g) return Promise.resolve(null);
      if (type === 'svg') return g.toSVG({ copyStyles: false, preserveDimensions: true });
      return g.toPNG({ padding: 40 });
    },

    pageToLocal(clientX, clientY) {
      return graphRef.current?.pageToLocal(clientX, clientY) ?? { x: 0, y: 0 };
    },

    alignSelected(dir) {
      const g = graphRef.current;
      if (!g) return;
      const cells = g.getSelectedCells().filter((c) => c.isNode());
      if (cells.length < 2) return;
      const positions = cells.map((c) => c.getPosition());
      const sizes = cells.map((c) => c.getSize());
      const centers = cells.map((c, i) => ({
        cx: positions[i].x + sizes[i].width / 2,
        cy: positions[i].y + sizes[i].height / 2,
      }));
      if (dir === 'left') {
        const minX = Math.min(...positions.map((p) => p.x));
        cells.forEach((c) => c.setPosition(minX, c.getPosition().y));
      } else if (dir === 'right') {
        const maxX = Math.max(...positions.map((p, i) => p.x + sizes[i].width));
        cells.forEach((c, i) => c.setPosition(maxX - sizes[i].width, c.getPosition().y));
      } else if (dir === 'center') {
        const avgCx = centers.reduce((sum, c) => sum + c.cx, 0) / centers.length;
        cells.forEach((c, i) => c.setPosition(avgCx - sizes[i].width / 2, c.getPosition().y));
      } else if (dir === 'top') {
        const minY = Math.min(...positions.map((p) => p.y));
        cells.forEach((c) => c.setPosition(c.getPosition().x, minY));
      } else if (dir === 'bottom') {
        const maxY = Math.max(...positions.map((p, i) => p.y + sizes[i].height));
        cells.forEach((c, i) => c.setPosition(c.getPosition().x, maxY - sizes[i].height));
      } else if (dir === 'middle') {
        const avgCy = centers.reduce((sum, c) => sum + c.cy, 0) / centers.length;
        cells.forEach((c, i) => c.setPosition(c.getPosition().x, avgCy - sizes[i].height / 2));
      }
    },

    distributeSelected(dir) {
      const g = graphRef.current;
      if (!g) return;
      const cells = g.getSelectedCells().filter((c) => c.isNode());
      if (cells.length < 3) return;
      if (dir === 'horizontal') {
        const sorted = [...cells].sort((a, b) => a.getPosition().x - b.getPosition().x);
        const first = sorted[0].getPosition().x;
        const last = sorted[sorted.length - 1].getPosition().x + sorted[sorted.length - 1].getSize().width;
        const totalW = sorted.reduce((s, c) => s + c.getSize().width, 0);
        const gap = (last - first - totalW) / (sorted.length - 1);
        let x = first;
        sorted.forEach((c) => { c.setPosition(x, c.getPosition().y); x += c.getSize().width + gap; });
      } else {
        const sorted = [...cells].sort((a, b) => a.getPosition().y - b.getPosition().y);
        const first = sorted[0].getPosition().y;
        const last = sorted[sorted.length - 1].getPosition().y + sorted[sorted.length - 1].getSize().height;
        const totalH = sorted.reduce((s, c) => s + c.getSize().height, 0);
        const gap = (last - first - totalH) / (sorted.length - 1);
        let y = first;
        sorted.forEach((c) => { c.setPosition(c.getPosition().x, y); y += c.getSize().height + gap; });
      }
    },
  }), []);

  // ── Graph initialisation ───────────────────────────────────────────────────
  useEffect(() => {
    ensureShapes();

    const colors = themeCanvasColors();

    const graph = new Graph({
      container: containerRef.current,
      autoResize: true,
      background: { color: colors.background },
      grid: {
        visible: true,
        type: 'dot',
        args: { color: colors.grid, thickness: 1 },
      },
      mousewheel: { enabled: true, zoomAtMousePosition: true, modifiers: null, minScale: 0.1, maxScale: 5 },
      panning: { enabled: true, modifiers: 'space' },
      resizing: { enabled: true, minWidth: 60, minHeight: 30 },
      connecting: {
        snap: { radius: 20 },
        allowBlank: false,
        allowLoop: false,
        allowMulti: true,
        allowNode: false,
        allowEdge: false,
        highlight: true,
        anchor: 'center',
        connectionPoint: 'bbox',
        router: { name: 'smooth' },
        connector: { name: 'smooth' },
        createEdge() {
          return new Edge({
            attrs: {
              line: {
                stroke: 'var(--color-accent)',
                strokeWidth: 2,
                targetMarker: { name: 'block', width: 8, height: 5 },
              },
            },
            zIndex: 10,
          });
        },
        validateMagnet() { return true; },
        validateConnection({ sourceCell, targetCell }) {
          return sourceCell !== targetCell;
        },
      },
      highlighting: {
        magnetAdsorbed: {
          name: 'stroke',
          args: { attrs: { stroke: 'var(--color-accent)', strokeWidth: 3 } },
        },
      },
      interacting: {
        nodeMovable: true,
        edgeMovable: true,
        edgeLabelMovable: true,
        vertexMovable: true,
        vertexAddable: true,
        vertexDeletable: true,
      },
    });

    graph.use(new Scroller({ enabled: true, pannable: true }));
    graph.use(new Selection({
      enabled: true,
      rubberband: true,
      movable: true,
      showNodeSelectionBox: true,
      pointerEvents: 'none',
      className: 'x6-selection-box',
    }));
    graph.use(new Snapline({ enabled: true, sharp: true }));
    graph.use(new Keyboard({ enabled: true, global: false }));
    graph.use(new Clipboard({ enabled: true, useLocalStorage: false }));
    graph.use(new History({ enabled: true }));
    if (minimapRef.current) {
      graph.use(new MiniMap({ enabled: true, container: minimapRef.current, width: 160, height: 100, minScale: 0.05, maxScale: 2 }));
    }

    graphRef.current = graph;

    // ── Port visibility on hover (only in link mode) ──────────────────────────
    graph.on('node:mouseenter', ({ node }) => {
      node.getPorts().forEach((p) => {
        node.setPortProp(p.id, 'attrs/circle/opacity', 1);
      });
    });
    graph.on('node:mouseleave', ({ node }) => {
      node.getPorts().forEach((p) => {
        node.setPortProp(p.id, 'attrs/circle/opacity', 0);
      });
    });

    // ── Selection events → parent ─────────────────────────────────────────────
    graph.on('node:selected', ({ node }) => {
      const data = node.getData() || {};
      onNodeSelect?.(node.id, data);
    });
    graph.on('node:unselected', () => {
      // Parent decides whether to clear based on what replaced this selection
    });
    graph.on('edge:selected', ({ edge }) => {
      const data = edge.getData() || {};
      onEdgeSelect?.(edge.id, data);
    });
    graph.on('edge:unselected', () => {});
    graph.on('blank:click', () => onSelectionClear?.());
    graph.on('blank:mousedown', () => onSelectionClear?.());

    // ── Double-click to open editors ──────────────────────────────────────────
    graph.on('node:dblclick', ({ node, e }) => {
      e.stopPropagation();
      const data = node.getData() || {};
      if (data._cellType === 'zone') { node.trigger('zone:edit'); return; }
      if (data._cellType === 'shape') { node.trigger('shape:edit'); return; }
      if (data._cellType === 'label') { node.trigger('label:edit'); return; }
      // device: navigated via DeviceCell's own handler
    });

    // ── Node movement → debounced save ───────────────────────────────────────
    const moveSaveTimers = new Map();
    graph.on('node:moved', ({ node }) => {
      if (moveSaveTimers.has(node.id)) clearTimeout(moveSaveTimers.get(node.id));
      moveSaveTimers.set(node.id, setTimeout(() => {
        const pos = node.getPosition();
        const size = node.getSize();
        onNodeMoved?.(node.id, pos.x, pos.y, size.width, size.height);
        moveSaveTimers.delete(node.id);
      }, 500));
    });
    graph.on('node:resized', ({ node }) => {
      const pos = node.getPosition();
      const size = node.getSize();
      onNodeResized?.(node.id, pos.x, pos.y, size.width, size.height);
    });

    // ── Edge connection completed ──────────────────────────────────────────────
    graph.on('edge:connected', ({ edge, isNew }) => {
      if (!isNew) return;
      const src = edge.getSource();
      const tgt = edge.getTarget();
      if (!src.cell || !tgt.cell) {
        graph.removeEdge(edge);
        return;
      }
      onEdgePendingConnect?.({ edge, sourceId: src.cell, targetId: tgt.cell, sourcePort: src.port, targetPort: tgt.port });
    });

    // ── Edge vertex change → save ─────────────────────────────────────────────
    graph.on('edge:change:vertices', ({ edge }) => {
      const verts = edge.getVertices() || [];
      onEdgeVertexChanged?.(edge.id, verts);
    });

    // ── Delete via keyboard ───────────────────────────────────────────────────
    graph.on('cell:removed', ({ cell }) => {
      if (cell.isNode()) onNodeDeleted?.(cell.id, cell.getData() || {});
      else if (cell.isEdge()) onEdgeDeleted?.(cell.id, cell.getData() || {});
    });

    // ── Keyboard shortcuts ────────────────────────────────────────────────────
    graph.bindKey(['delete', 'backspace'], () => {
      const cells = graph.getSelectedCells();
      if (cells.length > 0) graph.removeCells(cells);
    });
    graph.bindKey('ctrl+a', () => graph.select(graph.getCells()));
    graph.bindKey('ctrl+shift+f', () => graph.fitToContent({ padding: 60 }));
    graph.bindKey('ctrl+equal', () => graph.zoom(0.1));
    graph.bindKey('ctrl+minus', () => graph.zoom(-0.1));
    graph.bindKey('escape', () => { graph.cleanSelection(); onSelectionClear?.(); });
    graph.bindKey('up',    () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(0, -1)));
    graph.bindKey('down',  () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(0,  1)));
    graph.bindKey('left',  () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(-1, 0)));
    graph.bindKey('right', () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate( 1, 0)));
    graph.bindKey('shift+up',    () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(0, -10)));
    graph.bindKey('shift+down',  () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(0,  10)));
    graph.bindKey('shift+left',  () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate(-10, 0)));
    graph.bindKey('shift+right', () => graph.getSelectedCells().filter((c) => c.isNode()).forEach((n) => n.translate( 10, 0)));
    graph.bindKey('ctrl+z',       () => graph.undo());
    graph.bindKey('ctrl+shift+z', () => graph.redo());
    graph.bindKey('ctrl+y',       () => graph.redo());
    graph.bindKey('ctrl+c', () => {
      const cells = graph.getSelectedCells();
      if (cells.length) graph.copy(cells);
    });
    graph.bindKey('ctrl+x', () => {
      const cells = graph.getSelectedCells();
      if (cells.length) graph.cut(cells);
    });
    graph.bindKey('ctrl+v', () => {
      if (!graph.isClipboardEmpty()) graph.paste({ offset: 40 });
    });

    return () => {
      moveSaveTimers.forEach((t) => clearTimeout(t));
      moveSaveTimers.clear();
      graph.dispose();
      graphRef.current = null;
    };
  // Only run on mount — props arrive through refs/callbacks; graph setup is one-time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Sync background + grid with the active theme ──────────────────────────
  // The background and grid pattern are rasterised by X6 with concrete color
  // values, so they must be redrawn whenever the theme toggles. Node/edge
  // colors use CSS var() references and restyle themselves via the cascade.
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    const colors = themeCanvasColors();
    g.drawBackground({ color: colors.background });
    g.drawGrid({ type: 'dot', args: { color: colors.grid, thickness: 1 } });
    if (!showGridRef.current) g.hideGrid();
  }, [background, theme]);

  // ── Sync grid visibility ───────────────────────────────────────────────────
  useEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    if (showGrid) g.showGrid();
    else g.hideGrid();
  }, [showGrid]);

  // ── Drop from DevicePicker ────────────────────────────────────────────────
  const handleDragOver = useCallback((e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }, []);
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const g = graphRef.current;
    if (!g) return;
    const point = g.pageToLocal(e.pageX, e.pageY);
    const manualData = e.dataTransfer.getData(MANUAL_DRAG_TYPE);
    const discoveredId = e.dataTransfer.getData(DISCOVERED_DRAG_TYPE);
    onDrop?.({ point, manualData: manualData ? JSON.parse(manualData) : null, discoveredId: discoveredId || null });
  }, [onDrop]);

  return (
    <TopologyGraphContext.Provider value={contextValue}>
      <div className="x6-canvas-wrapper" onDragOver={handleDragOver} onDrop={handleDrop}>
        <div ref={containerRef} className="x6-canvas-container" />
        {showMinimap && <div ref={minimapRef} className="x6-minimap" />}
      </div>
    </TopologyGraphContext.Provider>
  );
});

export default X6Canvas;
