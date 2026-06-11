import React from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from 'reactflow';
import { Pencil, X } from 'lucide-react';
import './ConnectionEdge.css';

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

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      <EdgeLabelRenderer>
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
