import { describe, expect, it } from "vite-plus/test";

import { markdownFrontmatterEnd, maskMarkdownFrontmatter } from "./markdownFrontmatter.ts";

describe("maskMarkdownFrontmatter", () => {
  it("blanks leading frontmatter without moving later offsets", () => {
    const markdown = "---\r\nname: skill\r\n---\r\n# Skill\n- [ ] item\n";
    const masked = maskMarkdownFrontmatter(markdown);

    expect(masked).toBe("   \r\n           \r\n   \r\n# Skill\n- [ ] item\n");
    expect(masked.indexOf("[ ]")).toBe(markdown.indexOf("[ ]"));
  });

  it("handles a byte order mark, CR line endings, and a ... closing fence", () => {
    expect(maskMarkdownFrontmatter("\uFEFF---\na: 1\n---\n# Body")).toBe("    \n    \n   \n# Body");
    expect(maskMarkdownFrontmatter("---\ra: 1\r...\r# Body")).toBe("   \r    \r   \r# Body");
    expect(maskMarkdownFrontmatter("---\n---\n# Body")).toBe("   \n   \n# Body");
  });

  it("leaves unterminated or non-leading fences alone", () => {
    expect(maskMarkdownFrontmatter("---\na: 1\n")).toBe("---\na: 1\n");
    expect(maskMarkdownFrontmatter("# A\n---\nb\n---\n")).toBe("# A\n---\nb\n---\n");
    expect(maskMarkdownFrontmatter("---\na: 1\n----\n")).toBe("---\na: 1\n----\n");
  });

  it("ends frontmatter where masking ends", () => {
    for (const markdown of [
      "---\r\nname: skill\r\n---\r\n# Skill\n",
      "\uFEFF---\na: 1\n...",
      "# A\n---\n",
    ]) {
      const end = markdownFrontmatterEnd(markdown);
      expect(maskMarkdownFrontmatter(markdown).slice(end)).toBe(markdown.slice(end));
      expect(maskMarkdownFrontmatter(markdown.slice(0, end)).trim()).toBe("");
    }
    expect(markdownFrontmatterEnd("---\na: 1\n---\nbody")).toBe(12);
    expect(markdownFrontmatterEnd("# A\n---\n")).toBe(0);
  });
});
