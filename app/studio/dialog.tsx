'use client';
import { useEffect, useRef } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { X } from 'lucide-react';

export type DeleteTarget = { kind: 'project' | 'archive'; id: string; title: string };
export type Zoom = { url: string; title: string };
export type EditTarget = { key: string; title: string };
export type DialogSet<T> = Dispatch<SetStateAction<T>>;

export function Dialog({
  children,
  close,
  wide = false,
}: {
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);

  useEffect(() => {
    closeRef.current = close;
  }, [close]);

  useEffect(() => {
    const node = dialog.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (node && !node.open) node.showModal();
    const first = node?.querySelector<HTMLElement>(
      'input, textarea, select, button:not(.close):not(.modal-dismiss)',
    );
    first?.focus();
    return () => {
      if (node?.open) node.close();
      previous?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="modal-scrim"
      aria-label="操作对话框"
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
    >
      <button
        className="modal-dismiss"
        aria-label="关闭对话框"
        onClick={close}
      />
      <div className={'edit-modal ' + (wide ? 'wide' : '')}>
        <button className="close" aria-label="关闭对话框" onClick={close}>
          <X />
        </button>
        {children}
      </div>
    </dialog>
  );
}
