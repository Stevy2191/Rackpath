import React from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, Position } from 'reactflow';
import { Pencil, X } from 'lucide-react';
import './ConnectionEdge.css';

// Small offset applied to an endpoint's interface label so it sits just
// outside the node, in the direction the edge leaves/enters that node.
function interfaceLabelOffset(position) {
  switch (position) {
    case Position.Top:
      return { x: 0, y: -12 };
    case Position.Bottom:
      return { x: 0, y: 12 };
    case Position.Left:
      return { x: -12, y: 0 };
    case Position.Right:
      return { x: 12, y: 0 };
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
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const edgeStyle = {
    ...style,
    stroke: selected ? 'var(--color-accent)' : style?.stroke,
    strokeWidth: selected ? 2.5 : style?.strokeWidth,
  };

  const sourceOffset = interfaceLabelOffset(sourcePosition);
  const targetOffset = interfaceLabelOffset(targetPosition);

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
          <div
            className="connection-edge-toolbar"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + (label ? 20 : 0)}px)`,
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
        )}
      </EdgeLabelRenderer>
    </>
  );
}
