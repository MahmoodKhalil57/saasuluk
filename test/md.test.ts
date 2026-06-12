import { test, expect, describe } from "bun:test";
import { md } from "../src/lib/md";

describe("md — tiny XSS-safe markdown renderer", () => {
  test("blocks: headings, lists, code fences, blockquotes, paragraphs", () => {
    const h = md("## Section\n\n- one\n- two\n\nA paragraph.\n\n```ts\nconst x = 1;\n```\n\n> a quote");
    expect(h).toContain("<h2>Section</h2>");
    expect(h).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(h).toContain("<p>A paragraph.</p>");
    expect(h).toContain("<pre><code>const x = 1;</code></pre>");
    expect(h).toContain("<blockquote>a quote</blockquote>");
  });

  test("inline: bold, italic, code, safe links", () => {
    const h = md("**bold** and *em* and `code` and [docs](/cost) and [ext](https://x.dev)");
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain("<em>em</em>");
    expect(h).toContain("<code>code</code>");
    expect(h).toContain('<a href="/cost">docs</a>');
    expect(h).toContain('<a href="https://x.dev">ext</a>');
  });

  test("XSS-safe: escapes raw HTML and refuses non-http(s)/relative link URLs", () => {
    const h = md('<script>alert(1)</scr' + 'ipt>\n\n[x](javascript:alert(1))');
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).not.toContain('<a href="javascript:'); // the unsafe URL is NOT turned into a link
  });
});
