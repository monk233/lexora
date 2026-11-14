import { expect, test } from "vitest";
import { markdownToPlain, renderMarkdown } from "./markdown";

test("escapes raw html", () => {
  expect(renderMarkdown("<img src=x onerror=alert(1)>")).not.toContain("<img");
});

test("renders bold and inline code", () => {
  const html = renderMarkdown("**bold** and `code`");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<code>code</code>");
});

test("rejects javascript links", () => {
  expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain('href="javascript:');
});

test("plain text strips markdown", () => {
  expect(markdownToPlain("**bold**")).toBe("bold");
});
