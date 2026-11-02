// Simple wave glyph mark (original, not the LearnHarness logo).
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12h3l2-5 3 10 3-14 3 12 2-3h4" />
    </svg>
  );
}
