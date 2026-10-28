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
    /* Selection / transform state (§11.12)                            */
    /* -------------------------------------------------------------- */

    var MIN_ANNOTATION_SIZE = 6;
    var HANDLE_HIT_SLOP = 9;
    var HANDLE_DRAW_SIZE = 8;
    var ROTATE_HANDLE_OFFSET = 26;
    var SELECT_COLOR = "#4f46e5";
    var HANDLE_IDS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

    var nextUid = 1;
    var selectedUid = null;
    var transformState = null;
    var hoverCursor = "";

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
      /* Annotations are confined to the selection rectangle (contract
       * §11.2/§11.11.5): everything outside stays untouched. */
      var box = selectionBounds();
      if (box) {
        context.save();
        context.beginPath();
        context.rect(box.x, box.y, box.width, box.height);
        context.clip();
      }
      drawRenderedList(context, size);
      if (draft) {
        /* Live preview (§11.11): the uncommitted op is painted above the
         * committed annotations and never enters history until pointerup. */
        drawAnnotationWithRotation(context, draftToAnnotation(draft), size);
      }
      if (box) {
        context.restore();
      }
      /* Selection handles/border are not clipped by the selection rectangle
       * (§11.12). */
      drawSelectionUi(context);
    }

    /* Committed annotations plus the live transform preview (drag in progress).
     * Rotation is applied around each annotation's bounding-box centre, in the
     * canvas and in renderToPng alike. */
    function drawRenderedList(targetContext, size) {
      var list = currentList();
      var previewIndex = transformState ? findSelectedIndex() : -1;
      for (var index = 0; index < list.length; index += 1) {
        var annotation =
          index === previewIndex ? transformState.preview : list[index];
        drawAnnotationWithRotation(targetContext, annotation, size);
      }
    }

    function drawAnnotationWithRotation(targetContext, annotation, size) {
      if (!annotation) {
        return;
      }
      var rotation = finite(annotation.rotation, 0);
      if (!rotation) {
        drawAnnotation(targetContext, annotation, size);
        return;
      }
      var box = annotationBounds(annotation);
      var center = box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: 0, y: 0 };
      targetContext.save();
      targetContext.translate(center.x, center.y);
      targetContext.rotate(rotation);
      targetContext.translate(-center.x, -center.y);
      drawAnnotation(targetContext, annotation, size);
      targetContext.restore();
    }

    /* Selection rectangle in CSS pixels, or null when the user has not framed
     * one yet. */
    function selectionBounds() {
      var selection = getSelection();
      if (!selection) {
        return null;
      }
      var x = finite(selection.x, 0);
      var y = finite(selection.y, 0);
      var width = finite(selection.width, 0);
      var height = finite(selection.height, 0);
      if (width <= 0 || height <= 0) {
        return null;
      }
      return { x: x, y: y, width: width, height: height };
    }

    function clampToSelection(point) {
      var box = selectionBounds();
      if (!box) {
        return point;
      }
      return {
        x: Math.min(box.x + box.width, Math.max(box.x, point.x)),
        y: Math.min(box.y + box.height, Math.max(box.y, point.y))
      };
    }

    function insideSelection(point) {
      var box = selectionBounds();
      if (!box) {
        return true;
      }
      return (
        point.x >= box.x &&
        point.x <= box.x + box.width &&
        point.y >= box.y &&
        point.y <= box.y + box.height
      );
    }

    function drawList(targetContext, list, size) {
      for (var index = 0; index < list.length; index += 1) {
        drawAnnotationWithRotation(targetContext, list[index], size);
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
     * the silhouette has the two barbs of the reference screenshot. Fill one
     * continuous outline so antialiasing cannot expose a seam at the neck. */
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
      targetContext.lineTo(baseX + px * headHalf, baseY + py * headHalf);
      targetContext.lineTo(annotation.x2, annotation.y2);
      targetContext.lineTo(baseX - px * headHalf, baseY - py * headHalf);
      targetContext.lineTo(baseX - px * shaftHalfAtHead, baseY - py * shaftHalfAtHead);
      targetContext.lineTo(
        annotation.x1 - px * shaftHalfAtTail,
        annotation.y1 - py * shaftHalfAtTail
      );
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
      /* Middle baseline per line: the glyphs sit centred in their line boxes, so
       * the selection box (lineHeight * lines) is vertically centred around the
       * text (round 20). */
      targetContext.textBaseline = "middle";
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
          annotation.y + lineIndex * lineHeight + lineHeight / 2
        );
      }
      targetContext.restore();
    }

    function numberRadius(annotation) {
      var number = String(annotation.n == null ? "" : annotation.n);
      var fontSize = Math.max(8, annotation.fontSize || 24);
      return Math.max(9, fontSize * 0.62 + 3 * Math.max(1, number.length));
    }

    function drawNumber(targetContext, annotation) {
      var number = String(annotation.n == null ? "" : annotation.n);
      var fontSize = Math.max(8, annotation.fontSize || 24);
      var radius = numberRadius(annotation);
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
    /* Selection, hit testing & transforms (§11.12)                    */
    /* -------------------------------------------------------------- */

    function cloneAnnotation(annotation) {
      if (!annotation) {
        return null;
      }
      return JSON.parse(JSON.stringify(annotation));
    }

    function ensureUid(annotation) {
      if (annotation && annotation.uid === undefined) {
        annotation.uid = nextUid;
        nextUid += 1;
      }
      return annotation;
    }

    function findSelectedIndex() {
      if (selectedUid === null) {
        return -1;
      }
      var list = currentList();
      for (var index = 0; index < list.length; index += 1) {
        if (list[index] && list[index].uid === selectedUid) {
          return index;
        }
      }
      return -1;
    }

    function selectedAnnotation() {
      var index = findSelectedIndex();
      return index >= 0 ? currentList()[index] : null;
    }

    function clearSelection() {
      if (selectedUid === null) {
        return;
      }
      selectedUid = null;
      requestRender();
    }

    function cancelTransform() {
      if (!transformState) {
        return false;
      }
      transformState = null;
      requestRender();
      return true;
    }

    function rotateVector(x, y, angle) {
      var cos = Math.cos(angle);
      var sin = Math.sin(angle);
      return { x: x * cos - y * sin, y: x * sin + y * cos };
    }

    function pointInRotatedBox(point, box, rotation) {
      var centerX = box.x + box.w / 2;
      var centerY = box.y + box.h / 2;
      var local = rotateVector(
        point.x - centerX,
        point.y - centerY,
        -(rotation || 0)
      );
      return (
        Math.abs(local.x) <= box.w / 2 + 2 &&
        Math.abs(local.y) <= box.h / 2 + 2
      );
    }

    function measureTextBounds(annotation) {
      var text = String(annotation.text == null ? "" : annotation.text);
      if (!text) {
        return null;
      }
      var lines = text.replace(/\r/g, "").split("\n");
      var fontSize = Math.max(8, annotation.fontSize || 24);
      var lineHeight = fontSize * TEXT_LINE_RATIO;
      var widest = 0;
      context.save();
      context.font = textFont(annotation);
      for (var index = 0; index < lines.length; index += 1) {
        widest = Math.max(widest, context.measureText(lines[index]).width);
      }
      context.restore();
      var padX = annotation.bg ? TEXT_PAD_X : 0;
      var padY = annotation.bg ? TEXT_PAD_Y : 0;
      /* Text is drawn with a middle baseline per line (see drawText), so the
       * selection box is exactly the block of line boxes and the glyphs are
       * vertically centred inside it (round 20). */
      return {
        x: annotation.x - padX,
        y: annotation.y - padY,
        w: widest + padX * 2,
        h: lineHeight * lines.length + padY * 2
      };
    }

    /* Unrotated bounding box of an annotation in CSS pixels. */
    function annotationBounds(annotation) {
      if (!annotation) {
        return null;
      }
      var type = annotation.type === "ellipse" ? "circle" : annotation.type;
      var box = null;
      var index;
      if (type === "rect" || type === "circle") {
        box = { x: annotation.x, y: annotation.y, w: annotation.w, h: annotation.h };
      } else if (type === "line" || type === "arrow") {
        var minimumX = Math.min(annotation.x1, annotation.x2);
        var minimumY = Math.min(annotation.y1, annotation.y2);
        var expand = Math.max(4, (annotation.width || 1) * 1.5);
        box = {
          x: minimumX - expand,
          y: minimumY - expand,
          w: Math.abs(annotation.x2 - annotation.x1) + expand * 2,
          h: Math.abs(annotation.y2 - annotation.y1) + expand * 2
        };
      } else if (type === "pen" || type === "mosaic") {
        var points = annotation.points || [];
        if (!points.length) {
          return null;
        }
        var pad =
          type === "mosaic"
            ? Math.max(6, (annotation.mosaicSize || 8) * 2)
            : Math.max(4, (annotation.width || 1) / 2 + 3);
        var left = points[0].x;
        var top = points[0].y;
        var right = points[0].x;
        var bottom = points[0].y;
        for (index = 1; index < points.length; index += 1) {
          left = Math.min(left, points[index].x);
          top = Math.min(top, points[index].y);
          right = Math.max(right, points[index].x);
          bottom = Math.max(bottom, points[index].y);
        }
        box = {
          x: left - pad,
          y: top - pad,
          w: right - left + pad * 2,
          h: bottom - top + pad * 2
        };
      } else if (type === "text") {
        box = measureTextBounds(annotation);
      } else if (type === "number") {
        var radius = numberRadius(annotation);
        box = {
          x: annotation.x - radius,
          y: annotation.y - radius,
          w: radius * 2,
          h: radius * 2
        };
      }
      if (!box) {
        return null;
      }
      /* Keep tiny/linear annotations usable: handles need a minimum box. */
      if (box.w < 10) {
        box.x -= (10 - box.w) / 2;
        box.w = 10;
      }
      if (box.h < 10) {
        box.y -= (10 - box.h) / 2;
        box.h = 10;
      }
      return box;
    }

    function boxCenter(box) {
      return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    }

    function distanceToSegment(point, start, end) {
      var dx = end.x - start.x;
      var dy = end.y - start.y;
      var lengthSquared = dx * dx + dy * dy;
      if (lengthSquared === 0) {
        return Math.sqrt(
          Math.pow(point.x - start.x, 2) + Math.pow(point.y - start.y, 2)
        );
      }
      var t = clamp(
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
        0,
        1
      );
      return Math.sqrt(
        Math.pow(point.x - (start.x + t * dx), 2) +
          Math.pow(point.y - (start.y + t * dy), 2)
      );
    }

    /* Hit test one annotation; rotated annotations are tested in their local
     * (unrotated) frame. */
    function hitTestAnnotation(annotation, point) {
      var box = annotationBounds(annotation);
      if (!box) {
        return false;
      }
      var rotation = annotation.rotation || 0;
      var center = boxCenter(box);
      var local = rotateVector(point.x - center.x, point.y - center.y, -rotation);
      var type = annotation.type === "ellipse" ? "circle" : annotation.type;
      var index;
      if (type === "rect" || type === "circle") {
        return (
          Math.abs(local.x) <= box.w / 2 + 2 &&
          Math.abs(local.y) <= box.h / 2 + 2
        );
      }
      if (type === "line" || type === "arrow") {
        var tolerance = Math.max(9, (annotation.width || 1) / 2 + 6);
        var start = rotateVector(
          annotation.x1 - center.x,
          annotation.y1 - center.y,
          -rotation
        );
        var end = rotateVector(
          annotation.x2 - center.x,
          annotation.y2 - center.y,
          -rotation
        );
        return distanceToSegment(local, start, end) <= tolerance;
      }
      if (type === "pen") {
        var points = annotation.points || [];
        var penTolerance = Math.max(7, (annotation.width || 1) / 2 + 5);
        if (points.length === 1) {
          var single = rotateVector(
            points[0].x - center.x,
            points[0].y - center.y,
            -rotation
          );
          return distanceToSegment(local, single, single) <= penTolerance;
        }
        for (index = 1; index < points.length; index += 1) {
          var penStart = rotateVector(
            points[index - 1].x - center.x,
            points[index - 1].y - center.y,
            -rotation
          );
          var penEnd = rotateVector(
            points[index].x - center.x,
            points[index].y - center.y,
            -rotation
          );
          if (distanceToSegment(local, penStart, penEnd) <= penTolerance) {
            return true;
          }
        }
        return false;
      }
      if (type === "mosaic") {
        return Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2;
      }
      if (type === "text" || type === "number") {
        return Math.abs(local.x) <= box.w / 2 && Math.abs(local.y) <= box.h / 2;
      }
      return false;
    }

    function hitTestTopmost(point) {
      var list = currentList();
      for (var index = list.length - 1; index >= 0; index -= 1) {
        if (hitTestAnnotation(list[index], point)) {
          return { index: index, annotation: list[index] };
        }
      }
      return null;
    }

    /* Handle positions in world coordinates (already rotated). */
    function handleLocalPosition(id, box) {
      var halfWidth = box.w / 2;
      var halfHeight = box.h / 2;
      switch (id) {
        case "nw":
          return { x: -halfWidth, y: -halfHeight };
        case "n":
          return { x: 0, y: -halfHeight };
        case "ne":
          return { x: halfWidth, y: -halfHeight };
        case "e":
          return { x: halfWidth, y: 0 };
        case "se":
          return { x: halfWidth, y: halfHeight };
        case "s":
          return { x: 0, y: halfHeight };
        case "sw":
          return { x: -halfWidth, y: halfHeight };
        case "w":
          return { x: -halfWidth, y: 0 };
        case "rotate":
          return { x: 0, y: -halfHeight - ROTATE_HANDLE_OFFSET };
        default:
          return { x: 0, y: 0 };
      }
    }

    function selectionHandlePoints() {
      var annotation = selectionDisplayAnnotation();
      if (!annotation) {
        return [];
      }
      var box = annotationBounds(annotation);
      if (!box) {
        return [];
      }
      var center = boxCenter(box);
      var rotation = annotation.rotation || 0;
      var ids = HANDLE_IDS.concat(["rotate"]);
      var result = [];
      for (var index = 0; index < ids.length; index += 1) {
        var local = handleLocalPosition(ids[index], box);
        var world = rotateVector(local.x, local.y, rotation);
        result.push({
          id: ids[index],
          x: center.x + world.x,
          y: center.y + world.y,
          rotate: ids[index] === "rotate"
        });
      }
      return result;
    }

    function hitTestHandle(point) {
      var handles = selectionHandlePoints();
      for (var index = 0; index < handles.length; index += 1) {
        var handle = handles[index];
        var dx = point.x - handle.x;
        var dy = point.y - handle.y;
        if (Math.sqrt(dx * dx + dy * dy) <= HANDLE_HIT_SLOP + HANDLE_DRAW_SIZE / 2) {
          return handle.id;
        }
      }
      return null;
    }

    function handleCursor(id) {
      if (id === "rotate") {
        return "grab";
      }
      if (id === "nw" || id === "se") {
        return "nwse-resize";
      }
      if (id === "ne" || id === "sw") {
        return "nesw-resize";
      }
      if (id === "n" || id === "s") {
        return "ns-resize";
      }
      return "ew-resize";
    }

    function drawHandle(targetContext, x, y, isRotate) {
      targetContext.save();
      targetContext.translate(x, y);
      targetContext.fillStyle = "#ffffff";
      targetContext.strokeStyle = SELECT_COLOR;
      targetContext.lineWidth = 1.5;
      if (isRotate) {
        targetContext.beginPath();
        targetContext.arc(0, 0, HANDLE_DRAW_SIZE / 2 + 1.5, 0, Math.PI * 2);
        targetContext.fill();
        targetContext.stroke();
        targetContext.beginPath();
        targetContext.lineWidth = 1.3;
        targetContext.arc(0, 0, 3.4, -Math.PI * 0.15, Math.PI * 1.25);
        targetContext.stroke();
        targetContext.beginPath();
        targetContext.moveTo(-1.2, -4.4);
        targetContext.lineTo(2.4, -3.4);
        targetContext.lineTo(-0.6, -1.6);
        targetContext.closePath();
        targetContext.fillStyle = SELECT_COLOR;
        targetContext.fill();
      } else {
        targetContext.fillRect(
          -HANDLE_DRAW_SIZE / 2,
          -HANDLE_DRAW_SIZE / 2,
          HANDLE_DRAW_SIZE,
          HANDLE_DRAW_SIZE
        );
        targetContext.strokeRect(
          -HANDLE_DRAW_SIZE / 2,
          -HANDLE_DRAW_SIZE / 2,
          HANDLE_DRAW_SIZE,
          HANDLE_DRAW_SIZE
        );
      }
      targetContext.restore();
    }

    /* Selection UI is painted on the canvas (not exported, not clipped). */
    /* Annotation used to draw the selection box/handles: while a transform drag
     * is in progress this is the live preview, so the box follows the pointer
     * instead of only updating on pointerup (round 20). */
    function selectionDisplayAnnotation() {
      if (transformState && transformState.preview) {
        return transformState.preview;
      }
      return selectedAnnotation();
    }

    function drawSelectionUi(targetContext) {
      var annotation = selectionDisplayAnnotation();
      if (!annotation) {
        return;
      }
      var box = annotationBounds(annotation);
      if (!box) {
        return;
      }
      var center = boxCenter(box);
      var rotation = annotation.rotation || 0;
      targetContext.save();
      targetContext.translate(center.x, center.y);
      targetContext.rotate(rotation);
      targetContext.strokeStyle = SELECT_COLOR;
      targetContext.lineWidth = 1.2;
      targetContext.setLineDash([5, 3]);
      targetContext.strokeRect(-box.w / 2, -box.h / 2, box.w, box.h);
      targetContext.setLineDash([]);
      var rotateY = -box.h / 2 - ROTATE_HANDLE_OFFSET;
      targetContext.beginPath();
      targetContext.moveTo(0, -box.h / 2);
      targetContext.lineTo(0, rotateY);
      targetContext.stroke();
      for (var index = 0; index < HANDLE_IDS.length; index += 1) {
        var local = handleLocalPosition(HANDLE_IDS[index], box);
        drawHandle(targetContext, local.x, local.y, false);
      }
      drawHandle(targetContext, 0, rotateY, true);
      targetContext.restore();
    }

    /* ---- annotation geometry transforms ---- */

    function translateAnnotation(source, dx, dy) {
      var copy = cloneAnnotation(source);
      var type = copy.type === "ellipse" ? "circle" : copy.type;
      if (
        type === "rect" ||
        type === "circle" ||
        type === "text" ||
        type === "number"
      ) {
        copy.x += dx;
        copy.y += dy;
      } else if (type === "line" || type === "arrow") {
        copy.x1 += dx;
        copy.y1 += dy;
        copy.x2 += dx;
        copy.y2 += dy;
      } else if (type === "pen" || type === "mosaic") {
        copy.points = (copy.points || []).map(function (point) {
          return { x: point.x + dx, y: point.y + dy };
        });
      }
      return copy;
    }

    function rotateAnnotation(source, rotation) {
      var copy = cloneAnnotation(source);
      copy.rotation = rotation;
      return copy;
    }

    function computeScaleBox(origin, bounds, pointer, handle) {
      var rotation = origin.rotation || 0;
      var center = boxCenter(bounds);
      var local = rotateVector(pointer.x - center.x, pointer.y - center.y, -rotation);
      var left = -bounds.w / 2;
      var right = bounds.w / 2;
      var top = -bounds.h / 2;
      var bottom = bounds.h / 2;
      if (handle.indexOf("w") >= 0) {
        left = Math.min(local.x, right - MIN_ANNOTATION_SIZE);
      }
      if (handle.indexOf("e") >= 0) {
        right = Math.max(local.x, left + MIN_ANNOTATION_SIZE);
      }
      if (handle.indexOf("n") >= 0) {
        top = Math.min(local.y, bottom - MIN_ANNOTATION_SIZE);
      }
      if (handle.indexOf("s") >= 0) {
        bottom = Math.max(local.y, top + MIN_ANNOTATION_SIZE);
      }
      return {
        rotation: rotation,
        center: center,
        left: left,
        right: right,
        top: top,
        bottom: bottom,
        oldWidth: bounds.w,
        oldHeight: bounds.h
      };
    }

    function scaleAnnotation(source, geometry) {
      var copy = cloneAnnotation(source);
      var newWidth = geometry.right - geometry.left;
      var newHeight = geometry.bottom - geometry.top;
      var scaleX = newWidth / Math.max(1, geometry.oldWidth);
      var scaleY = newHeight / Math.max(1, geometry.oldHeight);
      var fontScale = Math.sqrt(Math.abs(scaleX * scaleY));
      var newLocalCenter = {
        x: (geometry.left + geometry.right) / 2,
        y: (geometry.top + geometry.bottom) / 2
      };
      var rotatedCenter = rotateVector(
        newLocalCenter.x,
        newLocalCenter.y,
        geometry.rotation
      );
      var newCenter = {
        x: geometry.center.x + rotatedCenter.x,
        y: geometry.center.y + rotatedCenter.y
      };
      function mapPoint(point) {
        var local = rotateVector(
          point.x - geometry.center.x,
          point.y - geometry.center.y,
          -geometry.rotation
        );
        var mapped = {
          x: geometry.left + (local.x + geometry.oldWidth / 2) * scaleX,
          y: geometry.top + (local.y + geometry.oldHeight / 2) * scaleY
        };
        var world = rotateVector(mapped.x, mapped.y, geometry.rotation);
        return {
          x: geometry.center.x + world.x,
          y: geometry.center.y + world.y
        };
      }
      var type = copy.type === "ellipse" ? "circle" : copy.type;
      if (type === "rect" || type === "circle") {
        copy.x = newCenter.x - newWidth / 2;
        copy.y = newCenter.y - newHeight / 2;
        copy.w = newWidth;
        copy.h = newHeight;
      } else if (type === "line" || type === "arrow") {
        var start = mapPoint({ x: copy.x1, y: copy.y1 });
        var end = mapPoint({ x: copy.x2, y: copy.y2 });
        copy.x1 = start.x;
        copy.y1 = start.y;
        copy.x2 = end.x;
        copy.y2 = end.y;
      } else if (type === "pen" || type === "mosaic") {
        copy.points = (copy.points || []).map(mapPoint);
      } else if (type === "text" || type === "number") {
        var anchor = mapPoint({ x: copy.x, y: copy.y });
        copy.x = anchor.x;
        copy.y = anchor.y;
        copy.fontSize = clamp(
          Math.round((copy.fontSize || 24) * fontScale),
          8,
          200
        );
      }
      return copy;
    }

    function startTransform(mode, point, handle, event) {
      var index = findSelectedIndex();
      if (index < 0) {
        return false;
      }
      var origin = cloneAnnotation(currentList()[index]);
      var bounds = annotationBounds(origin);
      if (!bounds) {
        return false;
      }
      var center = boxCenter(bounds);
      transformState = {
        mode: mode,
        handle: handle || "",
        origin: origin,
        bounds: bounds,
        startPoint: point,
        preview: origin,
        changed: false,
        startAngle: Math.atan2(point.y - center.y, point.x - center.x),
        rotation0: origin.rotation || 0
      };
      activePointerId =
        event && event.pointerId !== undefined ? event.pointerId : null;
      try {
        if (canvas.setPointerCapture && event && event.pointerId !== undefined) {
          canvas.setPointerCapture(event.pointerId);
        }
      } catch (error) {
        /* pointer capture is an optimisation only */
      }
      return true;
    }

    function updateTransform(point, event) {
      var transform = transformState;
      if (!transform) {
        return;
      }
      if (transform.mode === "move") {
        var dx = point.x - transform.startPoint.x;
        var dy = point.y - transform.startPoint.y;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
          transform.changed = true;
        }
        transform.preview = translateAnnotation(transform.origin, dx, dy);
      } else if (transform.mode === "scale") {
        transform.changed = true;
        transform.preview = scaleAnnotation(
          transform.origin,
          computeScaleBox(
            transform.origin,
            transform.bounds,
            point,
            transform.handle
          )
        );
      } else {
        var center = boxCenter(transform.bounds);
        var angle = Math.atan2(point.y - center.y, point.x - center.x);
        var rotation = transform.rotation0 + (angle - transform.startAngle);
        if (event && event.shiftKey) {
          var snap = Math.PI / 12;
          rotation = Math.round(rotation / snap) * snap;
        }
        if (Math.abs(angle - transform.startAngle) > 0.005) {
          transform.changed = true;
        }
        transform.preview = rotateAnnotation(transform.origin, rotation);
      }
      requestRender();
    }

    function endTransform(commit) {
      var transform = transformState;
      transformState = null;
      activePointerId = null;
      if (commit && transform && transform.changed && findSelectedIndex() >= 0) {
        var index = findSelectedIndex();
        var next = currentList().slice();
        next[index] = transform.preview;
        pushState(next);
        notifyHistory();
      }
      requestRender();
    }

    function deleteSelected() {
      var index = findSelectedIndex();
      if (index < 0) {
        return false;
      }
      var next = currentList().slice();
      next.splice(index, 1);
      pushState(next);
      selectedUid = null;
      notifyHistory();
      requestRender();
      return true;
    }

    function updateCanvasCursor(point) {
      var cursor = tool ? "crosshair" : "inherit";
      var selected = selectedAnnotation();
      if (selected) {
        var handle = hitTestHandle(point);
        if (handle) {
          cursor = handleCursor(handle);
        } else {
          var box = annotationBounds(selected);
          if (box && pointInRotatedBox(point, box, selected.rotation || 0)) {
            cursor = "move";
          } else {
            var hovered = hitTestTopmost(point);
            if (hovered) {
              cursor = "pointer";
            }
          }
        }
      } else if (!tool) {
        var topmost = hitTestTopmost(point);
        if (topmost) {
          cursor = "pointer";
        }
      }
      if (cursor !== hoverCursor) {
        hoverCursor = cursor;
        canvas.style.cursor = cursor;
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
      ensureUid(annotation);
      annotation.rotation = finite(annotation.rotation, 0);
      var next = currentList().slice();
      next.push(annotation);
      pushState(next);
      notifyHistory();
      /* Round 19: a freshly drawn annotation is NOT selected automatically;
       * clicking it later selects it for transforms (§11.12). */
      selectedUid = null;
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

    function releaseCanvasPointer(event) {
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
    }

    function startNewAnnotation(event, point) {
      if (!insideSelection(point)) {
        return;
      }
      event.preventDefault();
      try {
        if (
          canvas.setPointerCapture &&
          event.pointerId !== undefined
        ) {
          canvas.setPointerCapture(event.pointerId);
        }
      } catch (error) {
        /* pointer capture is an optimisation only */
      }
      point = clampToSelection(point);
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

    function onPointerDown(event) {
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      if (textSession) {
        /* Clicking outside the textarea blurs (commits) it first; do not start
         * another interaction from the same press. */
        return;
      }
      var point = pointFromEvent(event);

      /* 1) Transform handles / selected annotation body. Handles stay usable
       * even while a drawing tool is active (§11.12). */
      var selected = selectedAnnotation();
      if (selected) {
        var handle = hitTestHandle(point);
        if (
          handle &&
          startTransform(
            handle === "rotate" ? "rotate" : "scale",
            point,
            handle,
            event
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        var selectedBox = annotationBounds(selected);
        if (
          selectedBox &&
          pointInRotatedBox(point, selectedBox, selected.rotation || 0) &&
          startTransform("move", point, "", event)
        ) {
          event.preventDefault();
          event.stopPropagation();
          requestRender();
          return;
        }
      }

      /* 2) No tool: click another annotation to select it (drag = move), or let
       * the event bubble so capture.js can move/redraw the crop selection. */
      if (!tool) {
        var topmost = hitTestTopmost(point);
        if (topmost) {
          ensureUid(topmost.annotation);
          selectedUid = topmost.annotation.uid;
          startTransform("move", point, "", event);
          event.preventDefault();
          event.stopPropagation();
          requestRender();
          return;
        }
        clearSelection();
        return;
      }

      /* 3) A drawing tool is active. Clicking an existing annotation selects it
       * (round 19: drawings are no longer auto-selected, so this is how the user
       * gets the transform handles back); clicking empty space draws a new one. */
      var existing = hitTestTopmost(point);
      if (existing) {
        ensureUid(existing.annotation);
        selectedUid = existing.annotation.uid;
        startTransform("move", point, "", event);
        event.preventDefault();
        event.stopPropagation();
        requestRender();
        return;
      }
      clearSelection();
      startNewAnnotation(event, point);
    }

    function onPointerMove(event) {
      var point = pointFromEvent(event);
      if (transformState) {
        event.preventDefault();
        updateTransform(point, event);
        return;
      }
      if (activePointerId !== null && draft) {
        event.preventDefault();
        /* Keep the drag inside the selection: the pointer may leave the box while
         * the user keeps dragging, but the annotation stops at the edges. */
        var clamped = clampToSelection(point);
        if (draft.type === "pen" || draft.type === "mosaic") {
          var points = draft.points;
          var last = points[points.length - 1];
          var minimum =
            draft.type === "mosaic"
              ? Math.max(1.5, (draft.mosaicSize || 8) * 1.5)
              : 1;
          if (distance(last, clamped) >= minimum) {
            points.push(clamped);
          }
        } else {
          draft.x2 = clamped.x;
          draft.y2 = clamped.y;
        }
        requestRender();
        return;
      }
      updateCanvasCursor(point);
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
      releaseCanvasPointer(event);
      if (transformState) {
        endTransform(true);
        return;
      }
      if (activePointerId === null) {
        return;
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
      if (transformState) {
        transformState = null;
      }
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

    function isTypingTarget(target) {
      var tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
      return (
        tag === "textarea" ||
        tag === "input" ||
        tag === "select" ||
        !!(target && target.isContentEditable)
      );
    }

    /* Escape priority (§11.12): cancel the in-progress transform/stroke/text
     * input, then clear the selection; otherwise let `capture.js` handle the
     * colour panels / tool / capture cancellation. Delete/Backspace removes the
     * selected annotation. */
    function onKeyDownCapture(event) {
      var key = String(event.key || "");
      if (key === "Delete" || key === "Backspace") {
        if (textSession || isTypingTarget(event.target)) {
          return;
        }
        if (!selectedAnnotation()) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        deleteSelected();
        return;
      }
      if (key !== "Escape") {
        return;
      }
      if (textSession) {
        event.preventDefault();
        event.stopPropagation();
        cancelTextSession();
        return;
      }
      if (transformState) {
        event.preventDefault();
        event.stopPropagation();
        transformState = null;
        requestRender();
        return;
      }
      if (draft) {
        event.preventDefault();
        event.stopPropagation();
        cancelStroke();
        return;
      }
      if (selectedAnnotation()) {
        event.preventDefault();
        event.stopPropagation();
        clearSelection();
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
      for (var index = 0; index < list.length; index += 1) {
        drawAnnotationWithRotation(outputContext, list[index], size);
      }
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
        cancelTransform();
        tool = next;
        if (canvas) {
          /* The canvas must stay interactive even without a drawing tool so
           * existing annotations can be selected/moved (§11.12); capture.js
           * hides it when there is nothing to draw or select. */
          canvas.style.pointerEvents = "auto";
          canvas.style.cursor = tool ? "crosshair" : "inherit";
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
        cancelTransform();
        historyIndex -= 1;
        if (selectedUid !== null && findSelectedIndex() < 0) {
          selectedUid = null;
        }
        notifyHistory();
        requestRender();
        return true;
      },

      redo: function () {
        if (!editor.canRedo()) {
          return false;
        }
        cancelStroke();
        cancelTransform();
        historyIndex += 1;
        if (selectedUid !== null && findSelectedIndex() < 0) {
          selectedUid = null;
        }
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
        cancelTransform();
        selectedUid = null;
        if (!currentList().length) {
          requestRender();
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
        cancelTransform();
        selectedUid = null;
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

      /* §11.12 selection diagnostics used by tests/QA. */
      isInteracting: function () {
        return !!(transformState || activePointerId !== null);
      },

      getSelected: function () {
        var annotation = selectedAnnotation();
        return annotation ? cloneAnnotation(annotation) : null;
      },

      getSelectedBounds: function () {
        var annotation = selectionDisplayAnnotation();
        return annotation ? annotationBounds(annotation) : null;
      },

      getSelectionHandles: function () {
        return selectionHandlePoints();
      },

      selectAnnotationAt: function (x, y) {
        var hit = hitTestTopmost({ x: finite(x, 0), y: finite(y, 0) });
        if (hit) {
          ensureUid(hit.annotation);
          selectedUid = hit.annotation.uid;
          requestRender();
          return cloneAnnotation(hit.annotation);
        }
        selectedUid = null;
        requestRender();
        return null;
      },

      clearSelection: function () {
        clearSelection();
      },

      deleteSelection: function () {
        return deleteSelected();
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

    canvas.style.pointerEvents = "auto";
    canvas.style.touchAction = "none";
    /* Keep the annotation/selection layer above the dimming mask (z10) but below
     * the crop selection handles (z12) so the transform handles are not dimmed
     * and the crop handles still receive their events (§11.12). */
    canvas.style.zIndex = "11";
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
