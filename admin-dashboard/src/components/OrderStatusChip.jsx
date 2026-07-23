import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { presentStatus } from '../lib/orderStatus'

const MARGIN = 8 // gap between the chip and the tooltip, and from the viewport edge

// Customer-friendly status chip. `reason` is already plain-language text
// computed server-side (src/util/orderStatus.js) from local persisted data —
// this component only renders it, never re-derives or shortens it into jargon.
//
// The tooltip is rendered in a PORTAL directly under <body>, positioned with
// fixed coordinates computed from the chip's actual screen position. This is
// deliberate: the Orders table sits inside containers with overflow-x:auto /
// overflow:hidden (for the scrollbar and rounded corners), and an absolutely
// positioned tooltip nested inside them gets silently clipped by those
// ancestors regardless of z-index — which is exactly why it used to render
// cut off or in the wrong place. Escaping to a portal sidesteps that
// entirely, and the position is recalculated (and flipped above/below,
// clamped left/right) every time it opens, so it always fits on screen.
export function OrderStatusChip({ status, reason }) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState(null)
  const chipRef = useRef(null)
  const tooltipRef = useRef(null)
  const s = presentStatus(status)

  function reposition() {
    const chip = chipRef.current;
    const tip = tooltipRef.current;
    if (!chip) return;
    const chipRect = chip.getBoundingClientRect();
    const tipRect = tip?.getBoundingClientRect();
    const tipWidth = tipRect?.width || Math.min(300, window.innerWidth - MARGIN * 2);
    const tipHeight = tipRect?.height || 60;

    const spaceAbove = chipRect.top;
    const placeAbove = spaceAbove >= tipHeight + MARGIN || spaceAbove > window.innerHeight - chipRect.bottom;

    const top = placeAbove ? chipRect.top - tipHeight - MARGIN : chipRect.bottom + MARGIN;
    let left = chipRect.left + chipRect.width / 2 - tipWidth / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - tipWidth - MARGIN));

    setCoords({ top: Math.max(MARGIN, top), left, placement: placeAbove ? 'above' : 'below' });
  }

  // Measure twice: an initial estimate the instant it opens (so it never
  // renders at 0,0), then a precise pass once the tooltip's real size is in
  // the DOM (its text length varies a lot) — both before paint, so there's no
  // visible jump.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    reposition();
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onClickAway = (e) => {
      if (chipRef.current?.contains(e.target) || tooltipRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('resize', reposition);
    // Closing on scroll (rather than tracking it) avoids a stale/misplaced
    // tooltip while the table or page moves underneath it.
    window.addEventListener('scroll', close, true);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClickAway);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', close, true);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClickAway);
    };
  }, [open]);

  return (
    <span
      ref={chipRef}
      className={`status-chip status-chip-${s.variant}`}
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
    >
      <span aria-hidden="true">{s.emoji}</span>
      <span>{s.label}</span>
      {open && reason &&
        createPortal(
          <span
            ref={tooltipRef}
            role="tooltip"
            className={`status-tooltip-portal status-tooltip-${coords?.placement || 'above'}`}
            style={coords ? { top: coords.top, left: coords.left } : { top: -9999, left: -9999 }}
          >
            {reason}
          </span>,
          document.body
        )}
    </span>
  )
}

export default OrderStatusChip
