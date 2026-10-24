/* Minimal, dependency-free Markdown renderer for the picker result panel.
 *
 * Model output is untrusted: everything is HTML-escaped first, then a small
 * subset of Markdown is applied. Only http(s) links are allowed; link clicks are
 * intercepted by the picker and opened through the shell (`open_external`).
 *
 * Exposes:
 *   LP.renderMarkdown(text)  -> safe HTML string
 *   LP.markdownToPlain(text) -> plain text (for speech / clipboard fallback)
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function safeUrl(value) {
    var url = String(value == null ? "" : value).trim();
    if (!/^https?:\/\//i.test(url)) {
      return "";
    }
    return url;
  }

  function renderInline(text) {
    var value = String(text == null ? "" : text);
    // Protect inline code so emphasis/link markup inside it stays literal.
    var codes = [];
    value = value.replace(/`([^`]+)`/g, function (_, code) {
      codes.push("<code>" + code + "</code>");
      return "\u0000code" + (codes.length - 1) + "\u0000";
    });
    value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (_, label, url) {
      var href = safeUrl(url.replace(/&amp;/g, "&"));
      if (!href) {
        return label;
      }
      return (
        '<a href="' +
        escapeHtml(href) +
        '" rel="noreferrer noopener" data-external="1">' +
        label +
        "</a>"
      );
    });
    value = value.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    value = value.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    value = value.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    value = value.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    value = value.replace(/\u0000code(\d+)\u0000/g, function (_, index) {
      return codes[Number(index)] || "";
    });
    return value;
  }

  function splitRow(line) {
    var trimmed = String(line || "").trim();
    if (trimmed.charAt(0) === "|") {
      trimmed = trimmed.slice(1);
    }
    if (trimmed.charAt(trimmed.length - 1) === "|") {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed.split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function renderTable(lines) {
    var header = splitRow(lines[0]);
    var aligns = splitRow(lines[1]).map(function (cell) {
      var left = cell.charAt(0) === ":";
      var right = cell.charAt(cell.length - 1) === ":";
      if (left && right) {
        return "center";
      }
      return right ? "right" : left ? "left" : "";
    });
    var html = ["<table><thead><tr>"];
    header.forEach(function (cell, index) {
      html.push(
        '<th class="align-' +
          (aligns[index] || "left") +
          '">' +
          renderInline(escapeHtml(cell)) +
          "</th>"
      );
    });
    html.push("</tr></thead><tbody>");
    lines.slice(2).forEach(function (line) {
      var cells = splitRow(line);
      html.push("<tr>");
      header.forEach(function (_, index) {
        html.push(
          '<td class="align-' +
            (aligns[index] || "left") +
            '">' +
            renderInline(escapeHtml(cells[index] || "")) +
            "</td>"
        );
      });
      html.push("</tr>");
    });
    html.push("</tbody></table>");
    return html.join("");
  }

  function renderMarkdown(text) {
    var lines = String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    var html = [];
    var paragraph = [];
    var list = null; // { type: "ul" | "ol", items: [] }
    var blockquote = [];
    var index = 0;

    function flushParagraph() {
      if (!paragraph.length) {
        return;
      }
      html.push("<p>" + renderInline(escapeHtml(paragraph.join("\n"))).replace(/\n/g, "<br>") + "</p>");
      paragraph = [];
    }

    function flushList() {
      if (!list) {
        return;
      }
      html.push("<" + list.type + ">");
      list.items.forEach(function (item) {
        html.push("<li>" + renderInline(escapeHtml(item)) + "</li>");
      });
      html.push("</" + list.type + ">");
      list = null;
    }

    function flushQuote() {
      if (!blockquote.length) {
        return;
      }
      html.push("<blockquote>" + renderInline(escapeHtml(blockquote.join("\n"))).replace(/\n/g, "<br>") + "</blockquote>");
      blockquote = [];
    }

    function flushAll() {
      flushParagraph();
      flushList();
      flushQuote();
    }

    while (index < lines.length) {
      var line = lines[index];
      var trimmed = line.trim();

      // Fenced code block.
      if (/^```/.test(trimmed)) {
        flushAll();
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index].trim())) {
          codeLines.push(lines[index]);
          index += 1;
        }
        index += 1;
        html.push("<pre><code>" + escapeHtml(codeLines.join("\n")) + "</code></pre>");
        continue;
      }

      if (!trimmed) {
        flushAll();
        index += 1;
        continue;
      }

      // Heading.
      var heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flushAll();
        var level = heading[1].length;
        html.push("<h" + level + ">" + renderInline(escapeHtml(heading[2])) + "</h" + level + ">");
        index += 1;
        continue;
      }

      // Horizontal rule.
      if (/^(\*\s*){3,}$/.test(trimmed) || /^(-\s*){3,}$/.test(trimmed) || /^(_\s*){3,}$/.test(trimmed)) {
        flushAll();
        html.push("<hr>");
        index += 1;
        continue;
      }

      // Table.
      if (
        trimmed.indexOf("|") >= 0 &&
        index + 1 < lines.length &&
        isTableSeparator(lines[index + 1])
      ) {
        flushAll();
        var tableLines = [lines[index], lines[index + 1]];
        index += 2;
        while (index < lines.length && lines[index].trim().indexOf("|") >= 0) {
          tableLines.push(lines[index]);
          index += 1;
        }
        html.push(renderTable(tableLines));
        continue;
      }

      // Blockquote.
      if (/^>\s?/.test(trimmed)) {
        flushParagraph();
        flushList();
        blockquote.push(trimmed.replace(/^>\s?/, ""));
        index += 1;
        continue;
      }
      flushQuote();

      // Lists.
      var unordered = /^[-*+]\s+(.*)$/.exec(trimmed);
      var ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
      if (unordered || ordered) {
        flushParagraph();
        var type = ordered ? "ol" : "ul";
        if (list && list.type !== type) {
          flushList();
        }
        if (!list) {
          list = { type: type, items: [] };
        }
        list.items.push((unordered ? unordered[1] : ordered[1]) || "");
        index += 1;
        continue;
      }
      flushList();

      paragraph.push(trimmed);
      index += 1;
    }

    flushAll();
    return html.join("");
  }

  function markdownToPlain(text) {
    var value = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    value = value.replace(/```[^\n]*\n?/g, "");
    value = value.replace(/^#{1,6}\s+/gm, "");
    value = value.replace(/^\s*>\s?/gm, "");
    value = value.replace(/^\s*[-*+]\s+/gm, "");
    value = value.replace(/^\s*\d+[.)]\s+/gm, "");
    value = value.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    value = value.replace(/`([^`]+)`/g, "$1");
    value = value.replace(/\*\*([^*]+)\*\*/g, "$1");
    value = value.replace(/__([^_]+)__/g, "$1");
    value = value.replace(/~~([^~]+)~~/g, "$1");
    value = value.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
    value = value.replace(/^\s*\|?[\s:-]+\|[\s:|-]*$/gm, "");
    value = value.replace(/\|/g, " ");
    value = value.replace(/^[ \t]+|[ \t]+$/gm, "");
    return value.replace(/\n{3,}/g, "\n\n").trim();
  }

  LP.renderMarkdown = renderMarkdown;
  LP.markdownToPlain = markdownToPlain;
  LP.escapeHtml = escapeHtml;
})();
