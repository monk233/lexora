#!/usr/bin/env node
/**
 * Regenerates web/shared/skill-icons.js — the icon gallery used by custom
 * skills — from the Lucide icon set (https://lucide.dev, ISC license).
 *
 * Usage:
 *   node scripts/make_skill_icons.mjs
 *
 * The script downloads the `lucide-static` npm package into a temp directory,
 * so it needs network access and Node.js >= 20. The generated file is committed
 * to the repository; end users and release builds don't need this script.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'web', 'shared', 'skill-icons.js');

// Curated 200-icon set covering text/editing, search/language, AI, communication,
// study, productivity, nature, people, technology and everyday symbols.
const names = [
  // text & editing
  'pen-line', 'pen', 'pencil', 'type', 'text', 'text-cursor', 'text-quote', 'text-search',
  'case-sensitive', 'spell-check', 'spell-check-2', 'highlighter', 'eraser', 'scissors',
  'clipboard', 'clipboard-copy', 'clipboard-paste', 'clipboard-list', 'clipboard-check',
  'copy', 'files', 'file-text', 'file-pen', 'file-pen-line', 'file-check', 'file-search',
  'book-open', 'book', 'book-marked', 'book-open-check', 'notebook-pen', 'notebook-text',
  'library', 'quote', 'align-left', 'align-center', 'align-justify', 'indent-increase',
  'indent-decrease', 'bold', 'italic', 'underline', 'strikethrough', 'heading-1', 'heading-2',
  // lists & structure
  'list', 'list-ordered', 'list-checks', 'list-todo', 'list-filter', 'wrap-text',
  'pilcrow', 'baseline', 'kanban', 'layout-grid', 'layout-list', 'columns-3', 'rows-3',
  // language & search
  'languages', 'earth', 'globe', 'search', 'search-check', 'scan-search', 'scan-text',
  'scan-eye', 'map-pin', 'compass', 'navigation', 'link', 'link-2', 'external-link',
  'mouse-pointer-click', 'arrow-up-right', 'arrow-right', 'chevron-right',
  // AI & ideas
  'sparkles', 'sparkle', 'wand-sparkles', 'brain', 'brain-circuit', 'bot', 'cpu',
  'circuit-board', 'puzzle', 'target', 'trophy', 'badge-check', 'rocket', 'zap',
  // communication
  'message-circle', 'message-square', 'messages-square', 'mail', 'mail-open', 'at-sign',
  'send', 'reply', 'forward', 'megaphone', 'bell', 'headphones', 'mic', 'volume-2', 'speech',
  // learning & work
  'lightbulb', 'graduation-cap', 'school', 'briefcase', 'calendar', 'clock', 'alarm-clock',
  'timer', 'square-check-big', 'circle-check', 'shield-check', 'gauge', 'activity', 'trending-up',
  'bar-chart-3', 'table', 'table-2', 'calculator', 'sliders-horizontal', 'settings', 'wrench',
  'toolbox',
  // nature & symbols
  'star', 'heart', 'flame', 'leaf', 'sun', 'moon', 'cloud', 'droplet', 'snowflake',
  'rainbow', 'mountain', 'flower', 'tree-pine', 'anchor', 'flag', 'award', 'crown', 'gem',
  'orbit', 'infinity', 'omega', 'pi', 'sigma', 'frame', 'palette', 'microscope',
  // people
  'user', 'users', 'user-check', 'contact', 'smile', 'thumbs-up', 'hand', 'eye', 'eye-off',
  // technology
  'code', 'terminal', 'binary', 'braces', 'brackets', 'hash', 'wifi', 'bluetooth',
  'database', 'server', 'cloud-download', 'download', 'upload', 'refresh-cw', 'rotate-cw',
  'repeat', 'filter', 'layers', 'box', 'package',
  // office & misc
  'shield', 'lock', 'key', 'home', 'folder', 'folder-open', 'tag', 'tags', 'bookmark',
  'pin', 'plus', 'minus', 'x', 'check', 'send-horizontal', 'gift', 'coffee', 'music',
];

const unique = Array.from(new Set(names));
if (unique.length !== 200) {
  throw new Error(`icon list must contain exactly 200 unique names, got ${unique.length}`);
}

async function downloadLucide() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexora-lucide-'));
  const metaResponse = await fetch('https://registry.npmjs.org/lucide-static/latest');
  if (!metaResponse.ok) {
    throw new Error(`failed to query npm registry: HTTP ${metaResponse.status}`);
  }
  const meta = await metaResponse.json();
  const tarballUrl = meta && meta.dist && meta.dist.tarball;
  if (!tarballUrl) {
    throw new Error('lucide-static tarball URL missing from npm metadata');
  }
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    throw new Error(`failed to download lucide-static: HTTP ${tarballResponse.status}`);
  }
  const tarball = Buffer.from(await tarballResponse.arrayBuffer());
  const tarballPath = path.join(workDir, 'lucide-static.tgz');
  fs.writeFileSync(tarballPath, tarball);
  execFileSync('tar', ['-xzf', tarballPath, '-C', workDir], { cwd: workDir });
  const iconsDir = path.join(workDir, 'package', 'icons');
  if (!fs.existsSync(iconsDir)) {
    throw new Error('lucide-static package layout not recognized');
  }
  return { workDir, iconsDir };
}

function svgBody(iconsDir, name) {
  const file = path.join(iconsDir, `${name}.svg`);
  if (!fs.existsSync(file)) {
    throw new Error(`missing Lucide icon: ${name}`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>[\s\S]*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return inner;
}

function build(iconsDir) {
  const entries = unique.map((name) => {
    const body = svgBody(iconsDir, name);
    return (
      `    ${JSON.stringify(name)}: '<svg viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="1.8" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true">${body}</svg>',`
    );
  });

  return `/* Curated Lucide icon set (200 icons, ISC license) used as the icon gallery
 * for user-defined skills. Generated by scripts/make_skill_icons.mjs — do not
 * edit by hand. Legacy icon keys used by earlier builds are aliased below.
 * Lucide: https://lucide.dev · ISC license · Copyright (c) Lucide contributors.
 */
(function () {
  "use strict";

  var LP = (window.LP = window.LP || {});

  LP.CUSTOM_SKILL_ICON_SVGS = {
${entries.join('\n')}
  };

  LP.CUSTOM_SKILL_ICON_KEYS = Object.keys(LP.CUSTOM_SKILL_ICON_SVGS).sort();

  /* Old settings may reference the 12 hand-drawn icons from v0.1.x. */
  LP.LEGACY_SKILL_ICON_ALIASES = {
    sparkles: "sparkles",
    wand: "wand-sparkles",
    pen: "pen-line",
    book: "book-open",
    globe: "earth",
    code: "code",
    list: "list",
    chat: "message-circle",
    lightbulb: "lightbulb",
    quote: "quote",
    briefcase: "briefcase",
    star: "star",
  };

  LP.customSkillIconSvg = function (key) {
    var name = String(key || "");
    var icons = LP.CUSTOM_SKILL_ICON_SVGS || {};
    if (!icons[name]) {
      name = LP.LEGACY_SKILL_ICON_ALIASES[name] || "";
    }
    return icons[name] || "";
  };

  LP.skillIconSvg = function (key) {
    return LP.customSkillIconSvg(key);
  };
})();
`;
}

const { workDir, iconsDir } = await downloadLucide();
try {
  fs.writeFileSync(output, build(iconsDir), 'utf8');
  console.log(`wrote ${path.relative(root, output)} (${unique.length} icons)`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
