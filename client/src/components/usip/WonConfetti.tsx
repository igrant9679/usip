/**
 * A short CSS confetti burst after a deal goes Won (from /v2/deals, kept on
 * the one deal board when /v2/deals folded into /pipeline: U13, 2026-11-08).
 * Decorative and hidden from assistive tech; mounts for about 1.6 s.
 */
export function WonConfetti() {
  const pieces = Array.from({ length: 28 });
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100] overflow-visible">
      <style>{`@keyframes vconfetti { 0% { transform: translateY(-10px) rotate(0deg); opacity: 1; } 100% { transform: translateY(78vh) rotate(660deg); opacity: 0; } }`}</style>
      {pieces.map((_, i) => (
        <span
          key={i}
          className="absolute block rounded-[2px]"
          style={{
            left: `${(i * 37) % 100}%`,
            width: 6 + (i % 3) * 3,
            height: 10 + (i % 4) * 3,
            backgroundColor: ["#10B981", "#0EA5E9", "#F59E0B", "#EC4899", "#8B5CF6"][i % 5],
            animation: `vconfetti ${1.1 + (i % 5) * 0.12}s ease-in ${(i % 7) * 0.05}s forwards`,
          }}
        />
      ))}
    </div>
  );
}
