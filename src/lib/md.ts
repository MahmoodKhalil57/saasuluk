/**
 * A tiny, XSS-safe Markdown → HTML renderer for blog bodies (so a Post's `body` can carry headings, lists, code,
 * emphasis and links instead of one flat paragraph). HTML is escaped FIRST, then the markdown patterns are applied
 * to the escaped text, and links are restricted to http(s)/relative — so user content can never inject markup.
 * Deliberately small (no dep): blocks = code fences, ATX headings, unordered lists, blockquotes, paragraphs.
 */
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Inline spans, applied to ALREADY-escaped text: `code`, **bold**, *italic*, [text](safe-url). */
function inline(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g, '<a href="$2">$1</a>');
}

export function md(src: string): string {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++; out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`); continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) { const n = Math.max(2, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; } // # and ## → h2 (the article title is the only h1)
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^[-*]\s+/, ""))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`); continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`); continue;
    }
    if (line.trim() === "") { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,3}\s|[-*]\s|```|>\s?)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
