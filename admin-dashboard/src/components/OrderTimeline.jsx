// Expandable technical activity log for one order (Detected, Region Check,
// Login Retry, OTP, Portal Retry, final result, ...). Hidden by default —
// customers see only the final status; this is for whoever wants the detail.
export function OrderTimeline({ timeline }) {
  if (!timeline || timeline.length === 0) {
    return <p className="muted timeline-empty">No activity recorded for this order yet.</p>
  }

  return (
    <ol className="order-timeline">
      {timeline.map((step, i) => (
        <li key={i} className="order-timeline-step">
          <span className="order-timeline-dot" aria-hidden="true" />
          <span className="order-timeline-time">
            {step.ts ? new Date(step.ts).toLocaleTimeString() : '—'}
          </span>
          <span className="order-timeline-label">{step.label}</span>
        </li>
      ))}
    </ol>
  )
}

export default OrderTimeline
