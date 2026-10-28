const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "capture-annotate.js"), "utf8");
const arrowSource = source.slice(source.indexOf("    function drawArrow("), source.indexOf("    function drawPen("));
const drawArrow = vm.runInNewContext("(" + arrowSource.trim() + ")");

test("arrow head and shaft form one closed silhouette at every angle and size", () => {
  for (const length of [2, 30, 250, 1200]) {
    for (const width of [1, 4, 12]) {
      for (const angle of [0, Math.PI / 6, Math.PI / 2, Math.PI, -Math.PI / 4]) {
        const points = [];
        let begins = 0;
        let closes = 0;
        let fills = 0;
        const context = {
          save() {}, restore() {},
          beginPath() { begins++; },
          moveTo(x, y) { points.push([x, y]); },
          lineTo(x, y) { points.push([x, y]); },
          closePath() { closes++; },
          fill() { fills++; }
        };
        const x = 13.25;
        const y = 27.75;
        drawArrow(context, { x1: x, y1: y, x2: x + Math.cos(angle) * length,
          y2: y + Math.sin(angle) * length, width, color: "#123456" });
        assert.equal(begins, 1, "Separate paths introduce an antialiased internal seam");
        assert.equal(closes, 1);
        assert.equal(fills, 1, "The entire arrow must be rasterized in one fill");
        assert.equal(context.fillStyle, "#123456");
        assert.equal(points.length, 7);
        const local = points.map(([px, py]) => [
          (px - x) * Math.cos(angle) + (py - y) * Math.sin(angle),
          -(px - x) * Math.sin(angle) + (py - y) * Math.cos(angle)
        ]);
        const headLength = Math.min(Math.max(26, width * 8), length * 0.55, 120);
        const shaftHalf = Math.max(width * 1.2, headLength * 0.3);
        const headHalf = headLength * 0.62;
        const tailHalf = Math.max(0.4, width * 0.08);
        const expected = [[0, tailHalf], [length - headLength, shaftHalf],
          [length - headLength, headHalf], [length, 0],
          [length - headLength, -headHalf], [length - headLength, -shaftHalf], [0, -tailHalf]];
        local.forEach((point, i) => point.forEach((value, j) => {
          assert.ok(Math.abs(value - expected[i][j]) < 1e-8, "Preserve arrow proportions and endpoints");
        }));
      }
    }
  }
});

test("preview, redraw and PNG export share the arrow renderer", () => {
  assert.match(source, /case "arrow":\s*drawArrow\(targetContext, annotation\)/);
  assert.match(source, /drawAnnotationWithRotation\(context, draftToAnnotation\(draft\), size\)/);
  assert.match(source, /function drawRenderedList[\s\S]*?drawAnnotationWithRotation\(targetContext, annotation, size\)/);
  assert.match(source, /function renderToPng[\s\S]*?outputContext\.scale\(scaleX, scaleY\)[\s\S]*?drawAnnotationWithRotation\(outputContext, list\[index\], size\)/);
});
