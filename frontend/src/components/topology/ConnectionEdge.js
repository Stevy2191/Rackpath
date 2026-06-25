import React, { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow } from 'reactflow';
import { Minus, Pencil, Spline, X } from 'lucide-react';
import './ConnectionEdge.css';

// Linear interpolation between two points; t=0 is `a`, t=1 is `b`.
function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// How far along the edge (from each node) the port labels sit. Keeps them off
// the node's hostname caption and clearly on the edge line.
const PORT_LABEL_FRACTION = 0.28;

// Grid size (in flow coordinates) a waypoint snaps to while dragging, when
// the edge's "Link Snapping" setting is enabled.
const SNAP_GRID = 10;

// DB booleans round-trip as 0/1; treat anything falsy other than
// undefined/null (the "unset, default visible" case) as hidden.
function isLabelVisible(value) {
  return !(value === false || value === 0 || value === '0');
}

function snapPoint(point) {
  return { x: Math.round(point.x / SNAP_GRID) * SNAP_GRID, y: Math.round(point.y / SNAP_GRID) * SNAP_GRID };
}

export default function ConnectionEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  label,
  selected,
  data,
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [preview, setPreview] = useState(null);

  // A persisted waypoint (or a live drag preview) reroutes the edge through a
  // single bend point; otherwise it takes the default bezier path.
  const storedWaypoint =
    data?.waypoint_x != null && data?.waypoint_y != null ? { x: data.waypoint_x, y: data.waypoint_y } : null;
  const waypoint = preview || storedWaypoint;
  const pathStyle = data?.path_style || 'bezier';

  let edgePath;
  let labelX;
  let labelY;
  if (waypoint) {
    edgePath = `M ${sourceX},${sourceY} L ${waypoint.x},${waypoint.y} L ${targetX},${targetY}`;
    labelX = waypoint.x;
    labelY = waypoint.y;
  } else if (pathStyle === 'straight') {
    edgePath = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = (sourceY + targetY) / 2;
  } else {
    [edgePath, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }

  const edgeStyle = {
    ...style,
    stroke: selected ? 'var(--color-accent)' : style?.stroke,
    strokeWidth: selected ? 2.5 : style?.strokeWidth,
  };

  // Place each port label a fixed fraction along the edge, measured toward the
  // next path point (the waypoint if the edge is rerouted, otherwise the far
  // node). This keeps the label on the line and away from the node caption.
  const sourcePoint = { x: sourceX, y: sourceY };
  const targetPoint = { x: targetX, y: targetY };
  const sourceLabelPos = lerp(sourcePoint, waypoint || targetPoint, PORT_LABEL_FRACTION);
  const targetLabelPos = lerp(targetPoint, waypoint || sourcePoint, PORT_LABEL_FRACTION);

  const handlePointerDown = (e) => {
    e.stopPropagation();
    e.target.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (e.buttons !== 1) return;
    const point = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    setPreview(data?.snapping ? snapPoint(point) : point);
  };

  const handlePointerUp = (e) => {
    e.target.releasePointerCapture?.(e.pointerId);
    if (preview) {
      data?.onReroute?.(id, preview);
      setPreview(null);
    }
  };

  const handleDoubleClick = (e) => {
    e.stopPropagation();
    // Double-click the midpoint handle to straighten the edge again.
    data?.onReroute?.(id, null);
    setPreview(null);
  };

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      <EdgeLabelRenderer>
        {data?.source_interface && isLabelVisible(data?.source_label_visible) && (
          <div
            className="connection-edge-interface-label"
            style={{
              transform: `translate(-50%, -50%) translate(${sourceLabelPos.x}px, ${sourceLabelPos.y}px)`,
              color: data?.label_color || undefined,
            }}
          >
            {data.source_interface}
          </div>
        )}
        {data?.target_interface && isLabelVisible(data?.target_label_visible) && (
          <div
            className="connection-edge-interface-label"
            style={{
              transform: `translate(-50%, -50%) translate(${targetLabelPos.x}px, ${targetLabelPos.y}px)`,
              color: data?.label_color || undefined,
            }}
          >
            {data.target_interface}
          </div>
        )}
        {label && (
          <div
            className="connection-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              color: data?.label_color || undefined,
            }}
          >
            {label}
          </div>
        )}
        {selected && (
          <>
            {/* Draggable midpoint handle for rerouting the edge. */}
            <div
              className="connection-edge-midpoint"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onDoubleClick={handleDoubleClick}
              title="Drag to reroute · double-click to straighten"
            />
            <div
              className="connection-edge-toolbar"
              style={{
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (label ? 22 : 16)}px)`,
              }}
            >
              <button
                type="button"
                className="connection-edge-btn"
                onClick={() => data?.onEdit?.(id)}
                title="Edit connection"
                aria-label="Edit connection"
              >
                <Pencil size={12} strokeWidth={2.5} />
              </button>
              <button
                type="button"
                className="connection-edge-btn"
                title={pathStyle === 'straight' ? 'Switch to curved' : 'Switch to straight'}
                aria-label="Toggle path style"
                onClick={() => {
                  const edgeDbId = Number(id.replace('edge-', ''));
                  const next = pathStyle === 'straight' ? 'bezier' : 'straight';
                  data?.onUpdate?.(edgeDbId, { path_style: next });
                }}
              >
                {pathStyle === 'straight' ? <Spline size={12} strokeWidth={2.5} /> : <Minus size={12} strokeWidth={2.5} />}
              </button>
              <button
                type="button"
                className="connection-edge-btn connection-edge-btn-delete"
                onClick={() => data?.onDelete?.(id)}
                title="Delete connection"
                aria-label="Delete connection"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            </div>
          </>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
