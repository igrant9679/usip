/**
 * ChatMarkdown — renders the small markdown subset the assistant actually
 * writes, so answers read as formatted text instead of showing their markers.
 *
 * The model is told to answer in plain text with "tight lists", and it obliges
 * with **bold** run-ins, "- " bullets and numbered steps. Until now the chat
 * bubble printed the body straight into a <p>, so a heading arrived on screen
 * as the literal characters `**2 Proposed Meetings**`.
 *
 * Why hand-rolled rather than a library: `streamdown` is a dependency and is
 * used elsewhere, but this client runs Tailwind v4 with no config file and no
 * `@source` directive, and v4's automatic detection skips node_modules — so a
 * component that ships Tailwind utility classes in its own markup gets none of
 * them generated, and its lists come out unstyled. The same reason the repo
 * already hand-rolls the help-article renderer applies here.
 *
 * Anything unrecognised falls through as literal text: an answer is never
 * hidden because a marker did not parse.
 */
import { Link } from "wouter";
import type { ReactNode } from "react";

/** **bold**, `code`, [text](href) and *italic*, in that precedence. */
export function renderChatInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*([^*\s][^*]*)\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={k++} className="font-semibold">{m[2]}</strong>);
    else if (m[3]) out.push(<code key={k++} className="rounded bg-background/60 px-1 py-0.5 text-[0.85em]">{m[4]}</code>);
    else if (m[5]) {
      const href = m[7];
      out.push(
        href.startsWith("/")
          ? <Link key={k++} href={href} className="underline underline-offset-2">{m[6]}</Link>
          : <a key={k++} href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{m[6]}</a>,
      );
    } else if (m[8]) out.push(<em key={k++}>{m[9]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;

/**
 * Blocks: runs of bullets become a <ul>, runs of numbered lines an <ol>, and
 * everything else a paragraph. Blank lines separate blocks rather than
 * producing empty ones.
 */
export function ChatMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (BULLET.test(line)) {
      const items: string[] = [];
      while (i < lines.length && BULLET.test(lines[i])) {
        items.push(lines[i].match(BULLET)![1]);
        i++;
      }
      blocks.push(
        <ul key={k++} className="list-disc space-y-0.5 pl-4">
          {items.map((t, j) => <li key={j}>{renderChatInline(t)}</li>)}
        </ul>,
      );
      continue;
    }

    if (NUMBERED.test(line)) {
      const first = Number(lines[i].match(NUMBERED)![1]);
      const items: string[] = [];
      while (i < lines.length && NUMBERED.test(lines[i])) {
        items.push(lines[i].match(NUMBERED)![2]);
        i++;
      }
      blocks.push(
        <ol key={k++} start={first} className="list-decimal space-y-0.5 pl-4">
          {items.map((t, j) => <li key={j}>{renderChatInline(t)}</li>)}
        </ol>,
      );
      continue;
    }

    blocks.push(<p key={k++}>{renderChatInline(line)}</p>);
    i++;
  }

  if (!blocks.length) return null;
  return <div className="space-y-1.5 leading-relaxed">{blocks}</div>;
}
