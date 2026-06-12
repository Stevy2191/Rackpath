import React, { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position, useReactFlow } from 'reactflow';
import { Pencil, X } from 'lucide-react';
import './ConnectionEdge.css';

// Small offset applied to an endpoint's interface label so it sits just
// outside the node, in the direction the edge leaves/enters that node.
function interfaceLabelOffset(position) {
  switch (position) {
    case Position.Top:
      return { x: 0, y: -14 };
    case Position.Bottom:
      return { x: 0, y: 14 };
    case Position.Left:
      return { x: -14, y: 0 };
    case Position.Right:
      return { x: 14, y: 0 };
    default:
      return { x: 0, y: 0 };
  }
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

  let edgePath;
  let labelX;
  let labelY;
  if (waypoint) {
    edgePath = `M ${sourceX},${sourceY} L ${waypoint.x},${waypoint.y} L ${targetX},${targetY}`;
    labelX = waypoint.x;
    labelY = waypoint.y;
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

  const sourceOffset = interfaceLabelOffset(sourcePosition);
  const targetOffset = interfaceLabelOffset(targetPosition);

  const handlePointerDown = (e) => {
    e.stopPropagation();
    e.target.setPointerCapture?.(e.pointerId);
  };

  const handlePointerMove = (e) => {
    if (e.buttons !== 1) return;
    setPreview(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
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
        {data?.source_interface && (
          <div
            className="connection-edge-interface-label"
            style={{
              transform: `translate(-50%, -50%) translate(${sourceX + sourceOffset.x}px, ${
                sourceY + sourceOffset.y
              }px)`,
            }}
          >
            {data.source_interface}
          </div>
        )}
        {data?.target_interface && (
          <div
            className="connection-edge-interface-label"
            style={{
              transform: `translate(-50%, -50%) translate(${targetX + targetOffset.x}px, ${
                targetY + targetOffset.y
              }px)`,
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
