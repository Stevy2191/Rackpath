import React, { useEffect } from 'react';
import './ConfirmModal.css';

export default function ConfirmModal({ title, message, confirmLabel = 'Delete', onConfirm, onCancel }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="confirm-modal-overlay" onMouseDown={onCancel}>
      <div className="confirm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-modal-title">{title}</div>
        {message && <p className="confirm-modal-body">{message}</p>}
        <div className="confirm-modal-actions">
          <button type="button" className="confirm-modal-cancel" onClick={onCancel}>Cancel</button>
          <button type="button" className="confirm-modal-confirm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
