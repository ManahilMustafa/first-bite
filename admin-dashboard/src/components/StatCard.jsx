export function StatCard({ label, value, hint, accent }) {
  return (
    <div className={`stat-card ${accent ? `stat-card-${accent}` : ''}`}>
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {hint && <p className="stat-hint">{hint}</p>}
    </div>
  )
}
