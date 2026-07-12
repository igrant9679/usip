/**
 * ColorAvatar — deterministic hue-by-name initials avatar. One hash → same
 * colour everywhere a person appears (Deals owners, Conversations senders,
 * Team rows). Vibrance batch item (a).
 */
import { cn } from "@/lib/utils";

const HUES = [
  ["#0EA5E9", "#E0F2FE"], ["#8B5CF6", "#EDE9FE"], ["#F59E0B", "#FEF3C7"],
  ["#10B981", "#D1FAE5"], ["#EC4899", "#FCE7F3"], ["#06B6D4", "#CFFAFE"],
  ["#F43F5E", "#FFE4E6"], ["#84CC16", "#ECFCCB"], ["#6366F1", "#E0E7FF"],
];

export function ColorAvatar({ name, className, size = "size-7" }: { name?: string | null; className?: string; size?: string }) {
  const n = (name ?? "").trim() || "?";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const [fg, bg] = HUES[h % HUES.length];
  const initials = n.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full text-[11px] font-semibold", size, className)}
      style={{ backgroundColor: bg, color: fg }}
      title={n}
    >
      {initials}
    </span>
  );
}
