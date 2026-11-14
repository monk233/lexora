/* Shared constants for the migrated frontend ESM build.
 *
 * Ported from the still-unmigrated legacy sources:
 *   - LANGUAGES / deepMerge            <- web/shared/constants.js
 *   - CUSTOM_SKILL_ICON_KEYS           <- web/shared/skill-icons.js
 *
 * Only the three values the tauri-api bridge depends on live here; the legacy
 * files stay the source of truth for the `web/` pages until they are ported.
 */

export interface Language {
  value: string;
  label: string;
}

/* Translation target languages, shared by online and local AI tasks.
 * Common targets first for a short dropdown. */
export const LANGUAGES: Language[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "英语" },
  { value: "zh-hant", label: "繁体中文" },
  { value: "yue", label: "粤语" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "es", label: "西班牙语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "ru", label: "俄语" },
  { value: "ar", label: "阿拉伯语" },
  { value: "it", label: "意大利语" },
  { value: "nl", label: "荷兰语" },
  { value: "pl", label: "波兰语" },
  { value: "tr", label: "土耳其语" },
  { value: "th", label: "泰语" },
  { value: "vi", label: "越南语" },
  { value: "id", label: "印尼语" },
  { value: "ms", label: "马来语" },
  { value: "tl", label: "菲律宾语" },
  { value: "hi", label: "印地语" },
  { value: "bn", label: "孟加拉语" },
  { value: "ta", label: "泰米尔语" },
  { value: "te", label: "泰卢固语" },
  { value: "mr", label: "马拉地语" },
  { value: "gu", label: "古吉拉特语" },
  { value: "ur", label: "乌尔都语" },
  { value: "fa", label: "波斯语" },
  { value: "he", label: "希伯来语" },
  { value: "uk", label: "乌克兰语" },
  { value: "cs", label: "捷克语" },
  { value: "km", label: "高棉语" },
  { value: "my", label: "缅甸语" },
  { value: "bo", label: "藏语" },
  { value: "kk", label: "哈萨克语" },
  { value: "mn", label: "蒙古语" },
  { value: "ug", label: "维吾尔语" },
];

/* Icon gallery keys used by custom skills: `Object.keys(
 * LP.CUSTOM_SKILL_ICON_SVGS).sort()` extracted mechanically from
 * web/shared/skill-icons.js (202 keys). The 68 KB SVG payload
 * itself is intentionally not migrated. */
export const CUSTOM_SKILL_ICON_KEYS: string[] = [
  "activity",
  "alarm-clock",
  "align-center",
  "align-justify",
  "align-left",
  "anchor",
  "arrow-right",
  "arrow-up-right",
  "at-sign",
  "award",
  "badge-check",
  "bar-chart-3",
  "baseline",
  "bell",
  "binary",
  "bluetooth",
  "bold",
  "book",
  "book-marked",
  "book-open",
  "book-open-check",
  "bookmark",
  "bot",
  "box",
  "braces",
  "brackets",
  "brain",
  "brain-circuit",
  "briefcase",
  "calculator",
  "calendar",
  "case-sensitive",
  "check",
  "chevron-right",
  "circle-check",
  "circuit-board",
  "clipboard",
  "clipboard-check",
  "clipboard-copy",
  "clipboard-list",
  "clipboard-paste",
  "clock",
  "cloud",
  "cloud-download",
  "code",
  "coffee",
  "columns-3",
  "compass",
  "contact",
  "copy",
  "cpu",
  "crown",
  "database",
  "download",
  "droplet",
  "earth",
  "eraser",
  "external-link",
  "eye",
  "eye-off",
  "file-check",
  "file-pen",
  "file-pen-line",
  "file-search",
  "file-text",
  "files",
  "filter",
  "flag",
  "flame",
  "flower",
  "folder",
  "folder-open",
  "forward",
  "frame",
  "gauge",
  "gem",
  "gift",
  "globe",
  "graduation-cap",
  "hand",
  "hash",
  "heading-1",
  "heading-2",
  "headphones",
  "heart",
  "highlighter",
  "home",
  "indent-decrease",
  "indent-increase",
  "infinity",
  "italic",
  "kanban",
  "key",
  "languages",
  "layers",
  "layout-grid",
  "layout-list",
  "leaf",
  "library",
  "lightbulb",
  "link",
  "link-2",
  "list",
  "list-checks",
  "list-filter",
  "list-ordered",
  "list-todo",
  "lock",
  "mail",
  "mail-open",
  "map-pin",
  "megaphone",
  "message-circle",
  "message-square",
  "messages-square",
  "mic",
  "microscope",
  "minus",
  "moon",
  "mountain",
  "mouse-pointer-click",
  "music",
  "navigation",
  "notebook-pen",
  "notebook-text",
  "omega",
  "orbit",
  "package",
  "palette",
  "pen",
  "pen-line",
  "pencil",
  "pi",
  "pilcrow",
  "pin",
  "plus",
  "puzzle",
  "quote",
  "rainbow",
  "refresh-cw",
  "repeat",
  "reply",
  "rocket",
  "rotate-cw",
  "rows-3",
  "scan-eye",
  "scan-search",
  "scan-text",
  "school",
  "scissors",
  "scroll",
  "search",
  "search-check",
  "send",
  "send-horizontal",
  "server",
  "settings",
  "shield",
  "shield-check",
  "sigma",
  "sliders-horizontal",
  "smile",
  "snowflake",
  "sparkle",
  "sparkles",
  "speech",
  "spell-check",
  "spell-check-2",
  "square",
  "square-check-big",
  "star",
  "strikethrough",
  "sun",
  "table",
  "table-2",
  "tag",
  "tags",
  "target",
  "terminal",
  "text",
  "text-cursor",
  "text-quote",
  "text-search",
  "thumbs-up",
  "timer",
  "toolbox",
  "tree-pine",
  "trending-up",
  "trophy",
  "type",
  "underline",
  "upload",
  "user",
  "user-check",
  "users",
  "volume-2",
  "wand-sparkles",
  "wifi",
  "wrap-text",
  "wrench",
  "x",
  "zap",
];

export type PlainObject = Record<string, unknown>;

/** Recursively merge `patch` into a copy of `target` (ported verbatim from
 * `LP.deepMerge`). Arrays are copied, not merged; plain objects merge. */
export function deepMerge(target: PlainObject, patch: PlainObject): PlainObject {
  var result: PlainObject = {};
  var key;
  for (key in target) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      result[key] = target[key];
    }
  }
  for (key in patch) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) {
      continue;
    }
    var value = patch[key];
    var existing = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(existing as PlainObject, value as PlainObject);
    } else {
      result[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return result;
}
