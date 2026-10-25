/* Lexora screenshot annotation engine (contract §11.3).
 *
 * Creates the transparent drawing layer that sits above the frozen screenshot
 * and below the dimming mask (see `capture.html`). All geometry is stored in CSS
 * pixels relative to the overlay viewport and is therefore independent of the
 * selection rectangle: moving or resizing the crop never moves existing
 * annotations.
 *
 * Usage:
 *   var editor = window.CaptureAnnotate.create({
 *     canvas: document.getElementById("capture-annotations"),
 *     image: document.getElementById("capture-shot"),
 *     getSelection: function () { return {x, y, width, height}; },
 *     onHistoryChange: function (state) { }   // {canUndo, canRedo, hasAnnotations}
 *   });
 *
 * Painting tools get pointer events through the canvas; while no tool is
 * active the canvas is `pointer-events: none` so the selection interactions of
 * `capture.js` keep working. `renderToPng(rectCss)` rasterises the annotations
 * (transparent background) so the shell can alpha-composite them onto the crop.
 */
(function () {
  "use strict";

  var TOOLS = ["shape", "arrow", "pen", "text", "number", "mosaic"];
  /* §11.10.2: "circle" is the renamed ellipse mode; "ellipse" stays a legacy
   * alias so old persisted values/previews keep working. */
  var SHAPE_MODES = ["rect", "circle", "line"];
  var LEGACY_SHAPE_MODES = { ellipse: "circle" };
  var FILL_MODES = ["outline", "fill"];
  var MAX_HISTORY = 100; /* snapshots, i.e. far more than the required 50 steps */
  var FONT_STACK =
    '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
  var TEXT_PAD_X = 4;
  var TEXT_PAD_Y = 2;
  var TEXT_LINE_RATIO = 1.35;
  var MOSAIC_CELLS = 4; /* each mosaic stamp is a 4x4 grid of blocks */

  var DEFAULT_OPTIONS = {
    color: "#ef4444",
    width: 4,
    shapeMode: "rect",
    fill: "outline",
    fontSize: 24,
    bold: false,
    textBg: "",
    mosaicSize: 8
  };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function round(value) {
    return Math.round(Number(value) || 0);
  }

  function finite(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  /* Normalise a shape mode: "ellipse" (old name) maps to "circle" (§11.10.2). */
  function normalizeShapeMode(value) {
    var mode = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    if (LEGACY_SHAPE_MODES[mode]) {
      return LEGACY_SHAPE_MODES[mode];
    }
    return SHAPE_MODES.indexOf(mode) >= 0 ? mode : "rect";
  }

  function copyOptions(source) {
    return {
      color: source.color,
      width: source.width,
      shapeMode: source.shapeMode,
      fill: source.fill,
      fontSize: source.fontSize,
      bold: source.bold,
      textBg: source.textBg,
      mosaicSize: source.mosaicSize
    };
  }

  function distance(a, b) {
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function createCanvas() {
    return document.createElement("canvas");
  }

  /* Pick black or white text for a coloured background (numbers). */
  function contrastColor(color) {
    var hex = String(color || "").trim();
    var match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
    if (!match) {
      return "#ffffff";
    }
    var value = match[1];
    if (value.length === 3) {
      value = value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
    }
    var red = parseInt(value.slice(0, 2), 16);
    var green = parseInt(value.slice(2, 4), 16);
    var blue = parseInt(value.slice(4, 6), 16);
    var luminance = (red * 299 + green * 587 + blue * 114) / 1000;
    return luminance > 168 ? "#111827" : "#ffffff";
  }

  function create(options) {
    options = options || {};
    var canvas = options.canvas;
    if (!canvas || typeof canvas.getContext !== "function") {
      throw new Error("CaptureAnnotate: a canvas element is required");
    }
    var context = canvas.getContext("2d");
    var image = options.image || null;
    var getSelection =
      typeof options.getSelection === "function"
        ? options.getSelection
        : function () {
            return null;
          };
    var onHistoryChange =
      typeof options.onHistoryChange === "function"
        ? options.onHistoryChange
        : function () {};

    var optionsState = copyOptions(DEFAULT_OPTIONS);
    /* Physical size of the original screenshot (session width/height). Falls
     * back to `image.naturalWidth/Height`; capture.js keeps them in sync so the
     * exported PNG always matches the physical crop size the shell expects. */
    var sourceSize = null;
    var tool = null;
    var history = [[]];
    var historyIndex = 0;
    var draft = null;
    var activePointerId = null;
    var textSession = null;
    var renderQueued = false;
    var stampCanvas = createCanvas();
    stampCanvas.width = MOSAIC_CELLS;
    stampCanvas.height = MOSAIC_CELLS;
    var stampContext = stampCanvas.getContext("2d");

    /* -------------------------------------------------------------- */
    /* Canvas measurement / rendering                                  */
    /* -------------------------------------------------------------- */

    function cssSize() {
      var parent = canvas.parentNode;
      var width =
        canvas.clientWidth ||
        (parent && parent.clientWidth) ||
        document.documentElement.clientWidth ||
        1;
      var height =
        canvas.clientHeight ||
        (parent && parent.clientHeight) ||
        document.documentElement.clientHeight ||
        1;
      return { width: Math.max(1, width), height: Math.max(1, height) };
    }

    function prepareContext(targetContext, size) {
      var ratio = Math.max(1, finite(window.devicePixelRatio, 1));
      var backingWidth = Math.max(1, Math.round(size.width * ratio));
      var backingHeight = Math.max(1, Math.round(size.height * ratio));
      if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
        canvas.width = backingWidth;
        canvas.height = backingHeight;
      }
      if (typeof targetContext.setTransform === "function") {
        targetContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      } else {
        targetContext.save();
        targetContext.scale(ratio, ratio);
      }
      return targetContext;
    }

    function requestRender() {
      if (renderQueued) {
        return;
      }
      renderQueued = true;
      var run = function () {
        renderQueued = false;
        render();
      };
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(run);
      } else {
        window.setTimeout(run, 16);
      }
    }

    function render() {
      if (!context) {
        return;
      }
      var size = cssSize();
      prepareContext(context, size);
      context.clearRect(0, 0, size.width, size.height);
      drawList(context, history[historyIndex], size);
      if (draft) {
        /* Live preview (§11.11): the uncommitted op is painted above the
         * committed annotations and never enters history until pointerup. */
        drawAnnotation(context, draftToAnnotation(draft), size);
      }
    }

    function drawList(targetContext, list, size) {
      for (var index = 0; index < list.length; index += 1) {
        drawAnnotation(targetContext, list[index], size);
      }
    }

    /* A draft stores the raw drag form (x1/y1 -> x2/y2 for shapes/arrows, point
     * lists for pen/mosaic). Convert it to the geometry committed annotations
     * use so the live preview looks exactly like the final result. */
    function draftToAnnotation(source) {
      if (!source) {
        return null;
      }
      if (
        source.type === "rect" ||
        source.type === "circle" ||
        source.type === "ellipse" ||
        source.type === "line"
      ) {
        if (source.type === "line") {
          return {
            type: "line",
            x1: source.x1,
            y1: source.y1,
            x2: source.x2,
            y2: source.y2,
            color: source.color,
            width: source.width
          };
        }
        return {
          type: source.type,
          x: Math.min(source.x1, source.x2),
          y: Math.min(source.y1, source.y2),
          w: Math.abs(source.x2 - source.x1),
          h: Math.abs(source.y2 - source.y1),
          color: source.color,
          width: source.width,
          fill: source.fill === "fill" ? "fill" : "outline"
        };
      }
      /* Arrow/pen/mosaic drafts already use the committed drawing form. */
      return source;
    }

    /* -------------------------------------------------------------- */
    /* Drawing primitives                                              */
    /* -------------------------------------------------------------- */

    function setupStroke(targetContext, annotation) {
      targetContext.lineCap = "round";
      targetContext.lineJoin = "round";
      targetContext.strokeStyle = annotation.color;
      targetContext.lineWidth = Math.max(1, annotation.width || 1);
    }

    function drawRect(targetContext, annotation) {
      var width = annotation.w;
      var height = annotation.h;
      if (width <= 0 && height <= 0) {
        return;
      }
      targetContext.save();
      if (annotation.fill === "fill") {
        /* §11.10.5: filled shapes are solid (alpha = 1), QQ style. */
        targetContext.fillStyle = annotation.color;
        targetContext.fillRect(annotation.x, annotation.y, width, height);
      }
      setupStroke(targetContext, annotation);
      targetContext.strokeRect(annotation.x, annotation.y, width, height);
      targetContext.restore();
    }

    function drawEllipse(targetContext, annotation) {
      var rx = Math.max(0.5, annotation.w / 2);
      var ry = Math.max(0.5, annotation.h / 2);
      var cx = annotation.x + annotation.w / 2;
      var cy = annotation.y + annotation.h / 2;
      targetContext.save();
      targetContext.beginPath();
      if (typeof targetContext.ellipse === "function") {
        targetContext.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      } else {
        targetContext.save();
        targetContext.translate(cx, cy);
        targetContext.scale(rx, ry);
        targetContext.arc(0, 0, 1, 0, Math.PI * 2);
        targetContext.restore();
      }
      if (annotation.fill === "fill") {
        /* §11.10.5: solid fill, alpha = 1. */
        targetContext.fillStyle = annotation.color;
        targetContext.fill();
      }
      setupStroke(targetContext, annotation);
      targetContext.stroke();
      targetContext.restore();
    }

    function drawSegment(targetContext, annotation) {
      setupStroke(targetContext, annotation);
      targetContext.beginPath();
      targetContext.moveTo(annotation.x1, annotation.y1);
      targetContext.lineTo(annotation.x2, annotation.y2);
      targetContext.stroke();
    }

    /* QQ-style arrow (fifteenth round): a solid triangular head plus a tapered
     * cone-shaped tail. The shaft widens from a near-point at the start to a
     * narrow base at the head, and the head triangle is wider than that base, so
     * the silhouette has the two barbs of the reference screenshot. Both parts
     * are filled with the annotation colour (no stroke). */
    function drawArrow(targetContext, annotation) {
      var dx = annotation.x2 - annotation.x1;
      var dy = annotation.y2 - annotation.y1;
      var length = Math.sqrt(dx * dx + dy * dy);
      if (length < 1) {
        return;
      }
      var width = Math.max(1, annotation.width || 1);
      // Chunky QQ proportions: the head is clearly wider than the shaft and
      // scales with the line width, but never eats the whole arrow.
      var headLength = Math.min(Math.max(26, width * 8), length * 0.55, 120);
      var headHalf = headLength * 0.62;
      var shaftHalfAtHead = Math.max(width * 1.2, headLength * 0.3);
      var shaftHalfAtTail = Math.max(0.4, width * 0.08);
      var ux = dx / length;
      var uy = dy / length;
      var px = -uy;
      var py = ux;
      var baseX = annotation.x2 - ux * headLength;
      var baseY = annotation.y2 - uy * headLength;

      targetContext.save();
      targetContext.fillStyle = annotation.color || "#ef4444";
      targetContext.beginPath();
      targetContext.moveTo(
        annotation.x1 + px * shaftHalfAtTail,
        annotation.y1 + py * shaftHalfAtTail
      );
      targetContext.lineTo(baseX + px * shaftHalfAtHead, baseY + py * shaftHalfAtHead);
      targetContext.lineTo(baseX - px * shaftHalfAtHead, baseY - py * shaftHalfAtHead);
      targetContext.lineTo(
        annotation.x1 - px * shaftHalfAtTail,
        annotation.y1 - py * shaftHalfAtTail
      );
      targetContext.closePath();
      targetContext.fill();

      targetContext.beginPath();
      targetContext.moveTo(annotation.x2, annotation.y2);
      targetContext.lineTo(baseX + px * headHalf, baseY + py * headHalf);
      targetContext.lineTo(baseX - px * headHalf, baseY - py * headHalf);
      targetContext.closePath();
      targetContext.fill();
      targetContext.restore();
    }

    function drawPen(targetContext, annotation) {
      var points = annotation.points || [];
      if (!points.length) {
        return;
      }
      var width = Math.max(1, annotation.width || 1);
      targetContext.save();
      targetContext.lineCap = "round";
      targetContext.lineJoin = "round";
      targetContext.strokeStyle = annotation.color;
      targetContext.fillStyle = annotation.color;
      targetContext.lineWidth = width;
      if (points.length === 1) {
        targetContext.beginPath();
        targetContext.arc(points[0].x, points[0].y, width / 2, 0, Math.PI * 2);
        targetContext.fill();
      } else {
        targetContext.beginPath();
        targetContext.moveTo(points[0].x, points[0].y);
        for (var index = 1; index < points.length; index += 1) {
          targetContext.lineTo(points[index].x, points[index].y);
        }
        targetContext.stroke();
      }
      targetContext.restore();
    }

    /* Draws one pixelated stamp centred on (cx, cy). The source pixels come
     * from the screenshot <img>, so the live canvas and the exported PNG both
     * mosaic the real image rather than an approximation. */
    function drawMosaicStamp(targetContext, cx, cy, mosaicSize, size) {
      if (!image || !image.naturalWidth || !image.naturalHeight) {
        return;
      }
      var region = Math.max(2, mosaicSize) * MOSAIC_CELLS;
      var left = cx - region / 2;
      var top = cy - region / 2;
      var imageWidth = image.naturalWidth;
      var imageHeight = image.naturalHeight;
      var scaleX = imageWidth / size.width;
      var scaleY = imageHeight / size.height;
      var sourceX = left * scaleX;
      var sourceY = top * scaleY;
      var sourceWidth = region * scaleX;
      var sourceHeight = region * scaleY;
      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX + sourceWidth > imageWidth ||
        sourceY + sourceHeight > imageHeight
      ) {
        return;
      }
      if (stampCanvas.width !== MOSAIC_CELLS) {
        stampCanvas.width = MOSAIC_CELLS;
        stampCanvas.height = MOSAIC_CELLS;
        stampContext = stampCanvas.getContext("2d");
      }
      stampContext.imageSmoothingEnabled = true;
      stampContext.clearRect(0, 0, MOSAIC_CELLS, MOSAIC_CELLS);
      try {
        stampContext.drawImage(
          image,
          sourceX,
          sourceY,
          Math.max(1, sourceWidth),
          Math.max(1, sourceHeight),
          0,
          0,
          MOSAIC_CELLS,
          MOSAIC_CELLS
        );
      } catch (error) {
        return;
      }
      targetContext.save();
      targetContext.imageSmoothingEnabled = false;
      targetContext.drawImage(stampCanvas, left, top, region, region);
      targetContext.restore();
    }

    function drawMosaic(targetContext, annotation, size) {
      var points = annotation.points || [];
      var stampSize = Math.max(2, annotation.mosaicSize || optionsState.mosaicSize);
      for (var index = 0; index < points.length; index += 1) {
        drawMosaicStamp(targetContext, points[index].x, points[index].y, stampSize, size);
      }
    }

    function textFont(annotation) {
      var weight = annotation.bold ? "700 " : "400 ";
      return weight + Math.max(8, annotation.fontSize) + "px " + FONT_STACK;
    }

    function drawText(targetContext, annotation) {
      var text = String(annotation.text == null ? "" : annotation.text);
      if (!text) {
        return;
      }
      var lines = text.replace(/\r/g, "").split("\n");
      var fontSize = Math.max(8, annotation.fontSize || 24);
      var lineHeight = fontSize * TEXT_LINE_RATIO;
      targetContext.save();
      targetContext.font = textFont(annotation);
      targetContext.textAlign = "left";
      targetContext.textBaseline = "top";
      var widest = 0;
      for (var index = 0; index < lines.length; index += 1) {
        widest = Math.max(widest, targetContext.measureText(lines[index]).width);
      }
      if (annotation.bg) {
        targetContext.fillStyle = annotation.bg;
        targetContext.fillRect(
          annotation.x - TEXT_PAD_X,
          annotation.y - TEXT_PAD_Y,
          widest + TEXT_PAD_X * 2,
          lineHeight * lines.length + TEXT_PAD_Y * 2
        );
      }
      targetContext.fillStyle = annotation.color;
      for (var lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        targetContext.fillText(
          lines[lineIndex],
          annotation.x,
          annotation.y + lineIndex * lineHeight
        );
      }
      targetContext.restore();
    }

    function drawNumber(targetContext, annotation) {
      var number = String(annotation.n == null ? "" : annotation.n);
      var fontSize = Math.max(8, annotation.fontSize || 24);
      var radius = Math.max(9, fontSize * 0.62 + 3 * Math.max(1, number.length));
      targetContext.save();
      targetContext.beginPath();
      targetContext.arc(annotation.x, annotation.y, radius, 0, Math.PI * 2);
      targetContext.fillStyle = annotation.color;
      targetContext.fill();
      targetContext.fillStyle = contrastColor(annotation.color);
      targetContext.font =
        (annotation.bold ? "700 " : "600 ") +
        Math.max(9, Math.round(fontSize * 0.82)) +
        "px " +
        FONT_STACK;
      targetContext.textAlign = "center";
      targetContext.textBaseline = "middle";
      targetContext.fillText(number, annotation.x, annotation.y + 0.5);
      targetContext.restore();
    }

    function drawAnnotation(targetContext, annotation, size) {
      if (!annotation) {
        return;
      }
      switch (annotation.type) {
        case "rect":
          drawRect(targetContext, annotation);
          break;
        case "ellipse":
        case "circle":
          /* "ellipse" is the legacy name of the circle shape (§11.10.2). */
          drawEllipse(targetContext, annotation);
          break;
        case "line":
          drawSegment(targetContext, annotation);
          break;
        case "arrow":
          drawArrow(targetContext, annotation);
          break;
        case "pen":
          drawPen(targetContext, annotation);
          break;
        case "mosaic":
          drawMosaic(targetContext, annotation, size);
          break;
        case "text":
          drawText(targetContext, annotation);
          break;
        case "number":
          drawNumber(targetContext, annotation);
          break;
        default:
          break;
      }
    }

    /* -------------------------------------------------------------- */
    /* History                                                         */
    /* -------------------------------------------------------------- */

    function currentList() {
      return history[historyIndex];
    }

    function notifyHistory() {
      onHistoryChange({
        canUndo: editor.canUndo(),
        canRedo: editor.canRedo(),
        hasAnnotations: editor.hasAnnotations()
      });
    }

    function pushState(snapshot) {
      if (historyIndex < history.length - 1) {
        history = history.slice(0, historyIndex + 1);
      }
      history.push(snapshot);
      if (history.length > MAX_HISTORY + 1) {
        history.shift();
      }
      historyIndex = history.length - 1;
    }

    function commitAnnotation(annotation) {
      if (!annotation) {
        return;
      }
      var next = currentList().slice();
      next.push(annotation);
      pushState(next);
      notifyHistory();
      requestRender();
    }

    function nextNumber() {
      var list = currentList();
      var maximum = 0;
      for (var index = 0; index < list.length; index += 1) {
        if (list[index].type === "number" && list[index].n > maximum) {
          maximum = list[index].n;
        }
      }
      return maximum + 1;
    }

    /* -------------------------------------------------------------- */
    /* Pointer interaction                                             */
    /* -------------------------------------------------------------- */

    function pointFromEvent(event) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: finite(event.clientX, 0) - rect.left,
        y: finite(event.clientY, 0) - rect.top
      };
    }

    function cancelStroke() {
      if (!draft) {
        return false;
      }
      draft = null;
      activePointerId = null;
      requestRender();
      return true;
    }

    function onPointerDown(event) {
      if (!tool || (event.button !== undefined && event.button !== 0)) {
        return;
      }
      if (textSession) {
        /* Clicking outside the textarea blurs (commits) it first; do not start
         * another annotation from the same press. */
        return;
      }
      event.preventDefault();
      try {
        if (typeof canvas.setPointerCapture === "function") {
          canvas.setPointerCapture(event.pointerId);
        }
      } catch (error) {
        /* pointer capture is an optimisation only */
      }
      var point = pointFromEvent(event);
      activePointerId = event.pointerId;

      if (tool === "text") {
        activePointerId = null;
        openTextEditor(point);
        return;
      }
      if (tool === "number") {
        activePointerId = null;
        commitAnnotation({
          type: "number",
          x: point.x,
          y: point.y,
          n: nextNumber(),
          color: optionsState.color,
          fontSize: optionsState.fontSize,
          bold: optionsState.bold === true
        });
        return;
      }
      if (tool === "mosaic") {
        draft = {
          type: "mosaic",
          points: [point],
          mosaicSize: optionsState.mosaicSize
        };
        requestRender();
        return;
      }
      if (tool === "pen") {
        draft = {
          type: "pen",
          points: [point],
          color: optionsState.color,
          width: optionsState.width
        };
        requestRender();
        return;
      }
      if (tool === "shape") {
        draft = {
          type: optionsState.shapeMode,
          x1: point.x,
          y1: point.y,
          x2: point.x,
          y2: point.y,
          color: optionsState.color,
          width: optionsState.width,
          fill: optionsState.fill
        };
        requestRender();
        return;
      }
      if (tool === "arrow") {
        draft = {
          type: "arrow",
          x1: point.x,
          y1: point.y,
          x2: point.x,
          y2: point.y,
          color: optionsState.color,
          width: optionsState.width
        };
        requestRender();
      }
    }

    function onPointerMove(event) {
      if (activePointerId === null || !draft) {
        return;
      }
      event.preventDefault();
      var point = pointFromEvent(event);
      if (draft.type === "pen" || draft.type === "mosaic") {
        var points = draft.points;
        var last = points[points.length - 1];
        var minimum =
          draft.type === "mosaic"
            ? Math.max(1.5, (draft.mosaicSize || 8) * 1.5)
            : 1;
        if (distance(last, point) >= minimum) {
          points.push(point);
        }
      } else {
        draft.x2 = point.x;
        draft.y2 = point.y;
      }
      requestRender();
    }

    function finalizeAnnotation(annotation) {
      if (!annotation) {
        return null;
      }
      if (
        annotation.type === "rect" ||
        annotation.type === "circle" ||
        annotation.type === "ellipse" ||
        annotation.type === "line"
      ) {
        var x = Math.min(annotation.x1, annotation.x2);
        var y = Math.min(annotation.y1, annotation.y2);
        var width = Math.abs(annotation.x2 - annotation.x1);
        var height = Math.abs(annotation.y2 - annotation.y1);
        if (annotation.type === "line") {
          if (Math.sqrt(width * width + height * height) < 2) {
            return null;
          }
          return {
            type: "line",
            x1: annotation.x1,
            y1: annotation.y1,
            x2: annotation.x2,
            y2: annotation.y2,
            color: annotation.color,
            width: annotation.width
          };
        }
        if (width < 2 || height < 2) {
          return null;
        }
        return {
          type: annotation.type,
          x: x,
          y: y,
          w: width,
          h: height,
          color: annotation.color,
          width: annotation.width,
          fill: annotation.fill === "fill" ? "fill" : "outline"
        };
      }
      if (annotation.type === "arrow") {
        if (
          Math.sqrt(
            Math.pow(annotation.x2 - annotation.x1, 2) +
              Math.pow(annotation.y2 - annotation.y1, 2)
          ) < 2
        ) {
          return null;
        }
        return annotation;
      }
      if (annotation.type === "pen") {
        if (!annotation.points || !annotation.points.length) {
          return null;
        }
        return annotation;
      }
      if (annotation.type === "mosaic") {
        if (!annotation.points || !annotation.points.length) {
          return null;
        }
        return annotation;
      }
      return annotation;
    }

    function onPointerUp(event) {
      if (activePointerId === null) {
        return;
      }
      try {
        if (
          typeof canvas.releasePointerCapture === "function" &&
          event &&
          event.pointerId !== undefined
        ) {
          canvas.releasePointerCapture(event.pointerId);
        }
      } catch (error) {
        /* ignore */
      }
      activePointerId = null;
      var annotation = finalizeAnnotation(draft);
      draft = null;
      if (annotation) {
        commitAnnotation(annotation);
      } else {
        requestRender();
      }
    }

    function onPointerCancel() {
      activePointerId = null;
      draft = null;
      requestRender();
    }

    /* -------------------------------------------------------------- */
    /* Text tool                                                       */
    /* -------------------------------------------------------------- */

    function autoSizeTextarea(textarea, fontSize) {
      textarea.style.height = "auto";
      textarea.style.height =
        Math.max(fontSize * TEXT_LINE_RATIO + TEXT_PAD_Y * 2 + 2, textarea.scrollHeight) +
        "px";
    }

    function openTextEditor(point) {
      var fontSize = Math.max(8, optionsState.fontSize);
      var textarea = document.createElement("textarea");
      var session = {
        textarea: textarea,
        point: point,
        color: optionsState.color,
        fontSize: fontSize,
        bold: optionsState.bold === true,
        bg: optionsState.textBg || ""
      };
      textSession = session;
      textarea.setAttribute("wrap", "off");
      textarea.rows = 1;
      textarea.spellcheck = false;
      textarea.className = "capture-annotate-textarea";
      textarea.style.position = "fixed";
      textarea.style.left = Math.round(point.x) + "px";
      textarea.style.top = Math.round(point.y) + "px";
      textarea.style.zIndex = "9000";
      textarea.style.margin = "0";
      textarea.style.padding = TEXT_PAD_Y + "px " + TEXT_PAD_X + "px";
      textarea.style.minWidth = Math.max(80, fontSize * 3) + "px";
      textarea.style.width = Math.max(140, fontSize * 8) + "px";
      textarea.style.boxSizing = "border-box";
      textarea.style.resize = "none";
      textarea.style.overflow = "hidden";
      textarea.style.whiteSpace = "pre";
      textarea.style.fontFamily = FONT_STACK;
      textarea.style.fontSize = fontSize + "px";
      textarea.style.lineHeight = String(TEXT_LINE_RATIO);
      textarea.style.fontWeight = session.bold ? "700" : "400";
      textarea.style.color = session.color;
      textarea.style.background = session.bg || "rgba(255, 255, 255, 0.96)";
      textarea.style.border = "1px solid #4f46e5";
      textarea.style.borderRadius = "4px";
      textarea.style.outline = "none";
      textarea.style.boxShadow = "0 1px 3px rgba(15, 23, 42, 0.24)";
      textarea.style.caretColor = session.color;
      textarea.value = "";

      textarea.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelTextSession();
          return;
        }
        if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) {
          event.preventDefault();
          commitTextSession();
        }
      });
      textarea.addEventListener("input", function () {
        autoSizeTextarea(textarea, fontSize);
      });
      textarea.addEventListener("blur", function () {
        if (textSession === session) {
          commitTextSession();
        }
      });

      document.body.appendChild(textarea);
      autoSizeTextarea(textarea, fontSize);
      try {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      } catch (error) {
        /* focus may fail while the window is not focused yet */
      }
    }

    function commitTextSession() {
      var session = textSession;
      if (!session) {
        return;
      }
      textSession = null;
      var textarea = session.textarea;
      var text = String(textarea.value == null ? "" : textarea.value).replace(/\r/g, "");
      if (textarea.parentNode) {
        textarea.parentNode.removeChild(textarea);
      }
      if (text.trim() === "") {
        requestRender();
        return;
      }
      commitAnnotation({
        type: "text",
        x: session.point.x,
        y: session.point.y,
        text: text,
        color: session.color,
        fontSize: session.fontSize,
        bold: session.bold,
        bg: session.bg
      });
    }

    function cancelTextSession() {
      var session = textSession;
      if (!session) {
        return;
      }
      textSession = null;
      if (session.textarea.parentNode) {
        session.textarea.parentNode.removeChild(session.textarea);
      }
      requestRender();
    }

    /* Escape priority (§11.7): cancel the in-progress stroke / text input first
     * and keep the event from reaching the screenshot overlay handler. */
    function onKeyDownCapture(event) {
      if (event.key !== "Escape") {
        return;
      }
      if (textSession) {
        event.preventDefault();
        event.stopPropagation();
        cancelTextSession();
        return;
      }
      if (draft) {
        event.preventDefault();
        event.stopPropagation();
        cancelStroke();
      }
    }

    /* -------------------------------------------------------------- */
    /* Export                                                          */
    /* -------------------------------------------------------------- */

    function renderToPng(rectCss) {
      var list = currentList();
      if (!list.length) {
        return null;
      }
      var size = cssSize();
      var imageWidth =
        sourceSize && sourceSize.width
          ? sourceSize.width
          : image && image.naturalWidth
            ? image.naturalWidth
            : 0;
      var imageHeight =
        sourceSize && sourceSize.height
          ? sourceSize.height
          : image && image.naturalHeight
            ? image.naturalHeight
            : 0;
      var scaleX = imageWidth > 0 ? imageWidth / size.width : 1;
      var scaleY = imageHeight > 0 ? imageHeight / size.height : 1;
      var selection = rectCss || getSelection();
      var rect =
        selection && selection.width > 0 && selection.height > 0
          ? selection
          : { x: 0, y: 0, width: size.width, height: size.height };
      var outWidth = Math.max(1, Math.round(rect.width * scaleX));
      var outHeight = Math.max(1, Math.round(rect.height * scaleY));
      var output = createCanvas();
      output.width = outWidth;
      output.height = outHeight;
      var outputContext = output.getContext("2d");
      outputContext.clearRect(0, 0, outWidth, outHeight);
      outputContext.save();
      outputContext.translate(-rect.x * scaleX, -rect.y * scaleY);
      outputContext.scale(scaleX, scaleY);
      drawList(outputContext, list, size);
      outputContext.restore();
      return output.toDataURL("image/png");
    }

    /* -------------------------------------------------------------- */
    /* Public API                                                      */
    /* -------------------------------------------------------------- */

    var editor = {
      setTool: function (value) {
        var next =
          value === null || value === undefined || value === ""
            ? null
            : String(value).trim().toLowerCase();
        if (next !== null && TOOLS.indexOf(next) < 0) {
          next = null;
        }
        if (next === tool) {
          return tool;
        }
        cancelStroke();
        cancelTextSession();
        tool = next;
        if (canvas) {
          canvas.style.pointerEvents = tool ? "auto" : "none";
          canvas.style.cursor = tool ? "crosshair" : "";
          canvas.style.touchAction = "none";
          if (tool) {
            canvas.hidden = false;
          }
        }
        return tool;
      },

      getTool: function () {
        return tool;
      },

      setOption: function (key, value) {
        switch (key) {
          case "color":
            if (typeof value === "string" && value.trim()) {
              optionsState.color = value.trim();
            }
            break;
          case "width":
            optionsState.width = clamp(round(finite(value, 4)), 1, 20);
            break;
          case "shapeMode":
            optionsState.shapeMode = normalizeShapeMode(value);
            break;
          case "fill":
            if (FILL_MODES.indexOf(String(value)) >= 0) {
              optionsState.fill = String(value);
            }
            break;
          case "fontSize":
            optionsState.fontSize = clamp(round(finite(value, 24)), 12, 72);
            break;
          case "bold":
            optionsState.bold = value === true;
            break;
          case "textBg":
            optionsState.textBg = String(value == null ? "" : value).trim();
            break;
          case "mosaicSize":
            optionsState.mosaicSize = clamp(round(finite(value, 8)), 2, 30);
            break;
          default:
            break;
        }
        return undefined;
      },

      getOptions: function () {
        return copyOptions(optionsState);
      },

      setShapeMode: function (mode) {
        editor.setOption("shapeMode", mode);
      },

      /* Physical size of the session screenshot; keeps the exported annotation
       * layer at exactly the crop's physical pixel size (the shell composites
       * both layers 1:1). */
      setSourceSize: function (width, height) {
        var widthValue = finite(width, 0);
        var heightValue = finite(height, 0);
        sourceSize =
          widthValue > 0 && heightValue > 0
            ? { width: widthValue, height: heightValue }
            : null;
      },

      undo: function () {
        if (!editor.canUndo()) {
          return false;
        }
        cancelStroke();
        historyIndex -= 1;
        notifyHistory();
        requestRender();
        return true;
      },

      redo: function () {
        if (!editor.canRedo()) {
          return false;
        }
        cancelStroke();
        historyIndex += 1;
        notifyHistory();
        requestRender();
        return true;
      },

      canUndo: function () {
        return historyIndex > 0;
      },

      canRedo: function () {
        return historyIndex < history.length - 1;
      },

      clear: function () {
        cancelStroke();
        cancelTextSession();
        if (!currentList().length) {
          return;
        }
        pushState([]);
        notifyHistory();
        requestRender();
      },

      /* Called when the overlay is re-armed for a new capture: drops the
       * annotations *and* the undo history so nothing leaks between captures. */
      reset: function () {
        cancelStroke();
        cancelTextSession();
        history = [[]];
        historyIndex = 0;
        notifyHistory();
        requestRender();
      },

      hasAnnotations: function () {
        return currentList().length > 0;
      },

      /* Read-only copy for tests/diagnostics. */
      getAnnotations: function () {
        return currentList().slice();
      },

      /* The uncommitted live-preview op (null when not dragging). */
      getDraft: function () {
        return draft ? draftToAnnotation(draft) : null;
      },

      /* §11.10.3 eyedropper: sample the frozen screenshot pixel under a CSS
       * viewport point. Returns "#rrggbb" or null when the point is outside the
       * screenshot / the image is not decodable. */
      sampleColor: function (x, y) {
        if (!image || !image.naturalWidth || !image.naturalHeight) {
          return null;
        }
        var size = cssSize();
        var scaleX = image.naturalWidth / size.width;
        var scaleY = image.naturalHeight / size.height;
        var pixelX = Math.floor(finite(x, -1) * scaleX);
        var pixelY = Math.floor(finite(y, -1) * scaleY);
        if (
          pixelX < 0 ||
          pixelY < 0 ||
          pixelX >= image.naturalWidth ||
          pixelY >= image.naturalHeight
        ) {
          return null;
        }
        try {
          var buffer = createCanvas();
          buffer.width = image.naturalWidth;
          buffer.height = image.naturalHeight;
          var bufferContext = buffer.getContext("2d");
          bufferContext.drawImage(image, 0, 0);
          var pixel = bufferContext.getImageData(pixelX, pixelY, 1, 1).data;
          return (
            "#" +
            [pixel[0], pixel[1], pixel[2]]
              .map(function (channel) {
                var hex = Math.max(0, Math.min(255, channel)).toString(16);
                return hex.length === 1 ? "0" + hex : hex;
              })
              .join("")
          );
        } catch (error) {
          return null;
        }
      },

      renderToPng: renderToPng
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    document.addEventListener("keydown", onKeyDownCapture, true);
    window.addEventListener("resize", requestRender);

    canvas.style.pointerEvents = "none";
    canvas.style.touchAction = "none";
    notifyHistory();
    requestRender();

    return editor;
  }

  window.CaptureAnnotate = {
    create: create,
    TOOLS: TOOLS.slice(),
    SHAPE_MODES: SHAPE_MODES.slice(),
    DEFAULT_OPTIONS: copyOptions(DEFAULT_OPTIONS)
  };
})();
