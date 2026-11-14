/* Pure stream repetition guard extracted from web/picker.js (guardRepetition,
 * formerly picker.js:2192-2303). It touches no DOM, no LP runtime and no
 * module state; the window layer keeps stopRepeatedRequest and friends. */

export interface GuardRequest {
  kind?: string;
  imageAction?: string;
}

export interface GuardResult {
  text: string;
  repeated: boolean;
}

interface Region {
  start: number;
  end: number;
}

/* Conservative, exact natural-language repetition only. OCR remains literal.
 * A bounded tail keeps the periodic search independent of answer length. */
export function guardRepetition(
  text: string,
  request?: GuardRequest | null,
  source?: string | null,
): GuardResult {
  text = String(text || "");
  var unchanged: GuardResult = { text: text, repeated: false };
  if (request && request.kind === "image" && request.imageAction === "ocr") return unchanged;
  var preserveSource = !!(request && (request.kind === "translate" || request.kind === "polish"));
  function normalizeBlock(value: string): string {
    return value.replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
  }
  function sourceCopies(pattern: RegExp): number {
    if (!preserveSource || !source) return 0;
    var blocks = new RegExp(pattern.source, "g");
    var previous = "", count = 0, maximum = 0, block: RegExpExecArray | null;
    while ((block = blocks.exec(String(source)))) {
      var value = normalizeBlock(block[0]);
      count = value && value === previous ? count + 1 : 1;
      previous = value;
      maximum = Math.max(maximum, count);
    }
    return maximum;
  }
  var regions: Region[] = [];
  var fence: string | null = null;
  var quote = false;
  var offset = 0;
  var start = 0;
  text.split("\n").forEach(function (line) {
    var marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!line.trim()) quote = false;
    if (/^ {0,3}>/.test(line)) quote = true;
    var protectedLine = !!fence || !!marker || quote || /^(?: {4}|\t)/.test(line) || line.indexOf("|") !== -1;
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length &&
          /^\s*$/.test(line.slice(marker[0].length))) fence = null;
    }
    if (protectedLine) {
      if (offset > start) regions.push({ start: start, end: offset });
      start = offset + line.length + 1;
    }
    offset += line.length + 1;
  });
  if (start < text.length) regions.push({ start: start, end: text.length });
  // Split around inline code without changing source offsets or the output.
  // An unmatched delimiter protects the tail while its closing chunk is pending.
  var proseRegions: Region[] = [];
  regions.forEach(function (region) {
    var content = text.slice(region.start, region.end);
    var delimiters = /`+/g;
    var cursor = 0, opening: RegExpExecArray | null, closing: RegExpExecArray | null;
    while ((opening = delimiters.exec(content))) {
      if (opening.index > cursor) proseRegions.push({ start: region.start + cursor, end: region.start + opening.index });
      closing = null;
      var candidate: RegExpExecArray | null;
      while ((candidate = delimiters.exec(content))) {
        if (candidate[0].length === opening[0].length) { closing = candidate; break; }
      }
      if (!closing) { cursor = content.length; break; }
      cursor = delimiters.lastIndex;
    }
    if (cursor < content.length) proseRegions.push({ start: region.start + cursor, end: region.end });
  });
  regions = proseRegions;
  for (var r = 0; r < regions.length; r++) {
    var region = regions[r];
    var base = Math.max(region.start, region.end - 4096);
    // Avoid treating a truncated first line as a complete Markdown block.
    if (base > region.start) {
      var newline = text.indexOf("\n", base);
      if (newline >= 0 && newline < region.end) base = newline + 1;
    }
    var tail = text.slice(base, region.end);
    var regionText = text.slice(region.start, region.end);
    var blockPatterns = [/[^\n]+(?:\n(?!\s*\n|\s*(?:[-*+] |\d+[.)] ))[^\n]+)*/g, /[^\n]+/g];
    for (var pattern = 0; pattern < blockPatterns.length; pattern++) {
      var blocks = blockPatterns[pattern];
      var allowedCopies = Math.max(sourceCopies(blockPatterns[0]), sourceCopies(blockPatterns[1]));
      var previous = "", count = 0, firstEnd = 0, block: RegExpExecArray | null;
      while ((block = blocks.exec(regionText))) {
        var value = block[0].trim();
        var prose = value.replace(/^\s*(?:[-*+] |\d+[.)] )/, "");
        var han = prose.match(/[\u3400-\u9fff]/g) || [];
        var words = prose.match(/[A-Za-z]+/g) || [];
        if (han.length < 10 && (prose.length < 24 || words.length < 4)) { previous = ""; count = 0; continue; }
        value = normalizeBlock(value);
        if (value === previous) count++;
        else { previous = value; count = 1; firstEnd = block.index + block[0].length; }
        if (count >= 3 && count > allowedCopies) return { text: text.slice(0, region.start + firstEnd).trimEnd(), repeated: true };
      }
    }
    var cycles = /([\s\S]{24,1024}?)\1{3,}/g;
    var cycle: RegExpExecArray | null;
    while ((cycle = cycles.exec(tail))) {
      // Repeated source paragraphs may also match the character-cycle detector.
      if (preserveSource && cycle[0].split(cycle[1]).length - 1 <=
          Math.max(sourceCopies(blockPatterns[0]), sourceCopies(blockPatterns[1]))) continue;
      var unit = Array.from(cycle[1]);
      if (unit.length < 24) continue;
      // Repeated short terms are not a long-form generation loop.
      var shortPeriod = false;
      for (var size = 1; size < 24 && size < unit.length; size++) {
        if (unit.every(function (ch, i) { return ch === unit[i % size]; })) { shortPeriod = true; break; }
      }
      if (!shortPeriod) {
        var cycleStart = base + cycle.index;
        var length = cycle[1].length;
        while (cycleStart > region.start && text[cycleStart - 1] === text[cycleStart + length - 1]) cycleStart--;
        return { text: text.slice(0, cycleStart + length).trimEnd(), repeated: true };
      }
    }
  }
  return unchanged;
}
