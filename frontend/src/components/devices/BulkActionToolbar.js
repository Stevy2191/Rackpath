import React from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import './BulkActionToolbar.css';

export default function BulkActionToolbar({ count, onEdit, onDelete, onClear }) {
  if (!count) return null;

  return (
    <div className="bulk-action-toolbar">
      <span className="bulk-action-count">{count} selected</span>
      <button type="button" onClick={onEdit}>
        <Pencil size={14} /> Edit
      </button>
      <button type="button" className="bulk-action-danger" onClick={onDelete}>
        <Trash2 size={14} /> Delete
      </button>
      <button type="button" onClick={onClear}>
        <X size={14} /> Clear selection
      </button>
    </div>
  );
}
