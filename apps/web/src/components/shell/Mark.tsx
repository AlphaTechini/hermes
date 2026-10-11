/** The Hermes mark: a 22px rounded square filled with `--text`, an H whose crossbar continues into an arrow. Never recolor it. */
export function Mark({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 22 22" aria-hidden>
      <rect width="22" height="22" rx="6" fill="var(--text)" />
      <path
        d="M6.5 5.75v10.5M12.25 5.75v10.5M6.5 11h9.25M13.5 8.25 16.25 11l-2.75 2.75"
        fill="none"
        stroke="var(--canvas)"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
