/* Grip-handle reordering for the quote builder's scope lines and line items.
   Two input paths, one callback:

   · POINTER — the row only becomes draggable while the grip is held (arming it
     on mousedown), so text selection inside the row's inputs still works. That
     is the whole reason `armed` exists.
   · KEYBOARD — the grip is a real <button>, so Arrow Up/Down move the row
     without ever entering a drag. Native HTML5 drag-and-drop is mouse-only;
     shipping it alone would make reordering unreachable for a keyboard user.
*/

import { useCallback, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';

export interface ReorderApi {
  /** Spread onto the row (<tr> / <li>). */
  rowProps: (index: number) => {
    draggable: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
  /** Spread onto the grip button inside that row. */
  gripProps: (index: number) => {
    onMouseDown: () => void;
    onKeyDown: (e: KeyboardEvent) => void;
    onBlur: () => void;
  };
  /** Index currently being dragged, for the row's dragging affordance. */
  dragging: number | null;
}

export function useReorder(onMove: (from: number, to: number) => void): ReorderApi {
  // `armed` is STATE, not a ref: `draggable` is read during render, so arming it
  // in a ref would only take effect on some later, unrelated re-render.
  const [armed, setArmed] = useState<number | null>(null);
  const from = useRef<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);

  const rowProps = useCallback(
    (index: number) => ({
      draggable: armed === index,
      onDragStart: (e: DragEvent) => {
        if (armed !== index) {
          e.preventDefault();
          return;
        }
        from.current = index;
        setDragging(index);
        e.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload.
        e.dataTransfer.setData('text/plain', String(index));
      },
      onDragOver: (e: DragEvent) => {
        if (from.current === null) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault();
        if (from.current !== null && from.current !== index) onMove(from.current, index);
        from.current = null;
        setArmed(null);
        setDragging(null);
      },
      onDragEnd: () => {
        from.current = null;
        setArmed(null);
        setDragging(null);
      },
    }),
    [armed, onMove],
  );

  const gripProps = useCallback(
    (index: number) => ({
      onMouseDown: () => setArmed(index),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        onMove(index, index + (e.key === 'ArrowUp' ? -1 : 1));
      },
      onBlur: () => setArmed(null),
    }),
    [onMove],
  );

  return { rowProps, gripProps, dragging };
}
