const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(__dirname + '/capture.js', 'utf8');
function setup(options) {
  const window = { location: {search: ""}, devicePixelRatio: 1.5, setTimeout: () => 1, clearTimeout() {}, LP: options && options.LP };
  const document = { readyState: 'loading', addEventListener() {}, body: { classList: { add() {}, remove() {}, toggle() {} } } };
  vm.runInNewContext(source.replace('  /* ---- Boot', '  window.run = function (code) { return eval(code); };\n  /* ---- Boot'), { window, document, console });
  const run = window.run;
  run(`state.shotReady = true; state.originX = -1200; state.imageWidth=1200; state.imageHeight=900;
    window.realResetAnnotations = resetAnnotations;
    resetAnnotations = hideHint = hideLoupe = broadcastSelectionThrottled = broadcastSelection = function () {};
    viewportSize = function () { return {width: 800, height: 600}; };
    updateOutline = updateSizeLabel = layoutBar = layoutPalette = layoutFloatingPanels = function () {};
    rawPointFromEvent = function (e) { return {x:e.clientX, y:e.clientY}; };
    state.hoverGlobal = {x:-1050,y:150,width:300,height:300};
    state.hoverLocal = {x:100,y:100,width:200,height:200};
    dom.hover = {style:{}};
    window.realUpdateMask = updateMask; updateMask = function (rect) { window.mask = rect; };
    enterEditing = function (rect) { window.committed = rect; };
  `);
  return { window, run };
}

function setupToolbar() {
  const context = setup();
  context.run(`
    resetAnnotations=window.realResetAnnotations;
    hideLegacyLongshotProgress=stopColorPicking=closeAllColorPanels=syncShapeButtons=function(){};
    function button(title, action) {
      return {title, dataset:{}, disabled:false, classList:{remove(){},toggle(){}},
        setAttribute(){}, getAttribute(name){return name === 'data-action' ? action : null;}};
    }
    toolButtons = [button('矩形'), button('画笔')];
    dom.longshot = button('长截图', 'longshot');
    window.otherButton = button('其他工具', 'copy');
    dom.bar = {querySelectorAll(){return [dom.longshot, window.otherButton];}};
    state.layout = [{x:-1200,y:0,width:1200,height:900},{x:0,y:0,width:1600,height:900}];
    state.phase = 'editing'; state.selection={x:-100,y:10,width:100,height:100};
    state.hoverLocal = null; state.hoverGlobal = null;
    window.single = function(){state.selection={x:-100,y:10,width:100,height:100};};
    window.cross = function(){state.selection={x:-100,y:10,width:101,height:100};};
  `);
  return context;
}

test('cross-screen titles and disabled states restore after returning to one monitor', () => {
  const {run} = setupToolbar();
  run('updateCrossScreenUi(); window.cross(); updateCrossScreenUi(); updateBarState()');
  assert.equal(run('toolButtons[0].disabled'), true);
  // The test harness has no i18n pack, so LP.t falls back to the key.
  assert.equal(run('toolButtons[0].title'), 'capture.crossScreenAnnotate');
  assert.equal(run('dom.longshot.disabled'), true);
  run('window.single(); updateCrossScreenUi(); updateCrossScreenUi()');
  assert.equal(run('toolButtons[0].disabled'), false);
  assert.equal(run('toolButtons[0].title'), '矩形');
  assert.equal(run('dom.longshot.disabled'), false);
  assert.equal(run('dom.longshot.title'), '长截图');
  assert.equal(run('toolButtons[0].dataset.originalTitle'), undefined);
  assert.equal(run('window.otherButton.title'), '其他工具');
});

test('repeated synchronization preserves original titles and newer external titles', () => {
  const {run} = setupToolbar();
  run('window.cross(); updateCrossScreenUi(); updateCrossScreenUi(); updateBarState()');
  assert.equal(run('toolButtons[0].dataset.originalTitle'), '矩形');
  run(`toolButtons[0].title='新的标注提示'; dom.longshot.title='新的长截图提示';
    updateCrossScreenUi(); window.single(); updateCrossScreenUi()`);
  assert.equal(run('toolButtons[0].title'), '新的标注提示');
  assert.equal(run('dom.longshot.title'), '新的长截图提示');
  assert.equal(run('dom.longshot.dataset.originalTitle'), undefined);
});

test('busy, live longshot and cross-screen restrictions never enable one another', () => {
  const {run} = setupToolbar();
  for (const busy of [false, true]) {
    for (const longshot of [false, true]) {
      for (const cross of [false, true]) {
        run(`state.busy=${busy}; state.longshotActive=${longshot};
          window.${cross ? 'cross' : 'single'}(); updateCrossScreenUi(); updateBarState()`);
        assert.equal(run('toolButtons[0].disabled'), busy || longshot || cross);
        assert.equal(run('dom.longshot.disabled'), busy || longshot || cross);
        assert.equal(run('window.otherButton.disabled'), busy);
      }
    }
  }
});

test('resetAnnotations routes disabled state and titles through shared synchronization', () => {
  const {run} = setupToolbar();
  run('window.cross(); updateCrossScreenUi(); state.busy=true; resetAnnotations()');
  assert.equal(run('toolButtons[0].disabled'), true);
  run('window.single(); resetAnnotations()');
  assert.equal(run('toolButtons[0].disabled'), true);
  assert.equal(run('toolButtons[0].title'), '矩形');
  run('state.busy=false; resetAnnotations()');
  assert.equal(run('toolButtons[0].disabled'), false);
});

test('locale reads reuse setLocale so the static pass cannot reset rendered nodes', () => {
  const calls = { init: 0, setLocale: 0 };
  const i18n = {
    current: 'zh',
    currentLocale() { return this.current; },
    init(value) { calls.init += 1; this.current = value; },
    setLocale(value) {
      calls.setLocale += 1;
      if (value === this.current) return false;
      this.current = value;
      return true;
    },
  };
  const context = setup({ LP: { t: (key) => key, i18n } });
  const hint = { hidden: false, textContent: 'rendered-by-app', classList: { add() {}, remove() {} } };
  context.window.__testHint = hint;
  const { run } = context;
  run('dom.hint = window.__testHint; state.phase = "selecting"');
  assert.equal(run('applyLocale("en")'), true);
  assert.equal(calls.init, 1, 'the first read applies the static pass');
  // A stale/unchanged getState locale must not re-run init: that static pass
  // would overwrite the hint/preset text rendered from state.
  assert.equal(run('applyLocale("en")'), false);
  assert.equal(calls.init, 1);
  assert.equal(run('dom.hint.textContent'), 'capture.selectHint', 'the visible hint is retranslated');
  run('dom.hint.textContent = "rendered-by-app"');
  run('applyLocale("en")');
  assert.equal(run('dom.hint.textContent'), 'rendered-by-app', 'an unchanged locale leaves the rendered node alone');
  assert.equal(run('applyLocale("zh")'), true);
  assert.equal(calls.init, 1);
  assert.equal(run('dom.hint.textContent'), 'capture.selectHint', 'a real switch refreshes the rendered node');
});

test('load-error copy is re-localized from its key and keeps the raw backend detail', () => {
  const context = setup({ LP: { t: (key, params) => key + (params && params.error ? ':' + params.error : '') } });
  const node = { textContent: '' };
  context.window.__testError = node;
  const { run } = context;
  run('dom.errorText = window.__testError; state.loadErrorKey = "capture.loadFailed"; state.loadErrorText = ""; renderLoadErrorText()');
  assert.equal(run('dom.errorText.textContent'), 'capture.loadFailed');
  run('state.loadErrorKey = ""; state.loadErrorText = "截图失败"; renderLoadErrorText()');
  assert.equal(run('dom.errorText.textContent'), 'capture.loadFailedDetail:截图失败');
});

test('new capture restores titles even when cross-screen flag was reset first', () => {
  const {run} = setupToolbar();
  run(`window.cross(); updateCrossScreenUi(); dom.shot={}; API={monitor(){}};
    hideSelectionUi=hideErrorBar=hideToast=resetShotImage=setToolbarSkillsDefault=
      loadPickerSettings=pollMonitor=function(){};
    renderCaptureBar=function(){updateBarState();}; beginCapture(0)`);
  assert.equal(run('toolButtons[0].title'), '矩形');
  assert.equal(run('dom.longshot.title'), '长截图');
  assert.equal(run('dom.longshot.disabled'), false);
});

for (const interruption of ['onWindowBlur()', 'onPointerCancel()', 'cancelCapture()']) {
  test(interruption + ' restores titles after interrupted cross-screen selection', () => {
    const {run} = setupToolbar();
    run(`window.cross(); updateCrossScreenUi();
      state.phase='selecting'; state.drag={mode:'select'}; ${interruption}`);
    assert.equal(run('toolButtons[0].title'), '矩形');
    assert.equal(run('dom.longshot.title'), '长截图');
  });
}

test('blur without an active drag clears stale hints after returning to one monitor', () => {
  const {run} = setupToolbar();
  run('window.cross(); updateCrossScreenUi(); window.single(); onWindowBlur()');
  assert.equal(run('toolButtons[0].title'), '矩形');
  assert.equal(run('dom.longshot.disabled'), false);
});

test('cancelling an editing cross-screen selection restores both temporary hints', () => {
  const {run} = setupToolbar();
  run('window.cross(); updateCrossScreenUi(); cancelCapture()');
  assert.equal(run('toolButtons[0].title'), '矩形');
  assert.equal(run('dom.longshot.title'), '长截图');
  assert.equal(run('state.closed'), true);
});

test('cross-screen annotation cleanup runs once and keeps busy restrictions', () => {
  const {run} = setupToolbar();
  run(`window.resets=0; window.toasts=0; window.hasAnnotations=true;
    editor={hasAnnotations(){return window.hasAnnotations;},
      reset(){window.resets++; window.hasAnnotations=false;},setTool(){}};
    toast=function(){window.toasts++;}; state.busy=true;
    window.cross(); updateCrossScreenUi(); updateCrossScreenUi()`);
  assert.equal(run('window.resets'), 1);
  assert.equal(run('window.toasts'), 1);
  assert.equal(run('toolButtons[0].disabled'), true);
  run('window.single(); updateCrossScreenUi()');
  assert.equal(run('toolButtons[0].disabled'), true);
});

test('remote cross-screen broadcasts and repeated echoes synchronize real toolbar state', () => {
  const {run} = setupToolbar();
  run(`onSelectionState({phase:'editing',rect:{x:-100,y:10,width:101,height:100},owner:1});
    toolButtons[0].disabled=false; dom.longshot.disabled=false;
    onSelectionState({phase:'editing',rect:{x:-100,y:10,width:101,height:100},owner:1})`);
  assert.equal(run('dom.longshot.disabled'), true);
  assert.equal(run('toolButtons[0].disabled'), true);
  run(`onSelectionState({phase:'editing',rect:{x:-100,y:10,width:100,height:100},owner:1})`);
  assert.equal(run('dom.longshot.title'), '长截图');
  assert.equal(run('toolButtons[0].disabled'), false);
});

test('cross-screen detection requires positive intersection, including negative and vertical layouts', () => {
  const {run} = setupToolbar();
  assert.equal(run('isCrossScreenSelection()'), false);
  run('window.cross()');
  assert.equal(run('isCrossScreenSelection()'), true);
  run('state.selection.height=0');
  assert.equal(run('isCrossScreenSelection()'), false);
  run(`state.layout=[{x:-200,y:-900,width:1200,height:900},{x:-200,y:0,width:1200,height:900}];
    state.selection={x:-100,y:-100,width:100,height:100}`);
  assert.equal(run('isCrossScreenSelection()'), false);
  run('state.selection.height=101');
  assert.equal(run('isCrossScreenSelection()'), true);
  run('state.selection.width=0');
  assert.equal(run('isCrossScreenSelection()'), false);
});
test('click commits a copied snap rectangle and keeps preview until dragging', () => {
  const {window,run} = setup();
  run('startSelecting({x:120,y:120})');
  assert.equal(run('state.drag.snapGlobal.x'), -1050);
  assert.equal(window.mask.x, 100);
  run('state.hoverGlobal = null; state.hoverLocal = null; onMouseUp({})');
  assert.equal(window.committed.x, -1050);
  assert.equal(window.committed.width, 300);
});
test('hover mask uses the local snapped window', () => {
  const {window,run} = setup(); run('render()');
  assert.equal(window.mask.x, 100);
  assert.equal(window.mask.width, 200);
});
test('real drag commits manual rectangle and cannot revert to snap after returning', () => {
  const {window,run} = setup();
  run('startSelecting({x:120,y:120}); onMouseMove({clientX:180,clientY:200,buttons:1})');
  assert.equal(window.mask.width, 60);
  assert.equal(run('dom.hover.hidden'), true);
  run('onMouseUp({})');
  assert.equal(window.committed.width, 90);
  const second = setup();
  second.run('startSelecting({x:120,y:120}); onMouseMove({clientX:180,clientY:200,buttons:1}); onMouseMove({clientX:121,clientY:121,buttons:1})');
  assert.equal(second.run('state.drag.moved'), true);
  second.run('onMouseUp({})');
  assert.equal(second.window.committed, undefined);
});
test('stale hover responses and responses after leaving cannot update preview', async () => {
  const {run} = setup();
  run('window.requests = []; API = {hover: function () { return new Promise(function(resolve) { window.requests.push(resolve); }); }}; requestHover({x:10,y:10}); flushHover(); requestHover({x:20,y:20}); flushHover()');
  run('window.requests[1]({ok:true,rect:{x:-900,y:100,width:200,height:200}})');
  await Promise.resolve();
  run('window.requests[0]({ok:true,rect:{x:-1100,y:100,width:100,height:100}})');
  await Promise.resolve();
  assert.equal(run('state.hoverGlobal.x'), -900);
  run('requestHover({x:30,y:30}); flushHover(); onWindowMouseOut({relatedTarget:null}); window.requests[2]({ok:true,rect:{x:-900,y:100,width:200,height:200}})');
  await Promise.resolve();
  assert.equal(run('state.hoverGlobal'), null);
});
test('pointer cancellation clears snap preview without committing', () => {
  const {window,run} = setup();
  run('startSelecting({x:120,y:120}); onPointerCancel()');
  assert.equal(run('state.drag'), null);
  assert.equal(window.mask, null);
  assert.equal(window.committed, undefined);
});


test('queued mousemoves do not invalidate the latest sent hover request', async () => {
  const {run} = setup();
  run('window.requests=[]; API={hover:()=>new Promise(resolve=>window.requests.push(resolve))}; requestHover({x:10,y:10}); flushHover(); requestHover({x:20,y:20}); requestHover({x:30,y:30}); window.requests[0]({ok:true,rect:{x:-900,y:100,width:200,height:200}})');
  await Promise.resolve();
  assert.equal(run('state.hoverGlobal.x'), -900);
  run('flushHover(); window.requests[1]({ok:true,rect:{x:-800,y:100,width:200,height:200}})');
  await Promise.resolve();
  assert.equal(run('state.hoverGlobal.x'), -800);
});

test('fast cross-window click queries the press position instead of committing stale snap', async () => {
  const {window,run} = setup();
  run('window.queries=[]; API={hover:(x,y)=>new Promise(resolve=>window.queries.push({x,y,resolve}))}; startSelecting({x:400,y:200}); onMouseUp({})');
  assert.equal(window.committed, undefined);
  assert.equal(window.queries.length, 1);
  assert.equal(window.queries[0].x, -600);
  assert.equal(window.queries[0].y, 300);
  run('window.queries[0].resolve({ok:true,rect:{x:-650,y:200,width:300,height:400}})');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(window.committed.x, -650);
});

for (const cancel of ['onPointerCancel()', 'onWindowMouseOut({relatedTarget:null})', 'state.captureGeneration += 1', 'startSelecting({x:120,y:120})']) {
  test('pending click cannot commit after '+cancel, async () => {
    const {window,run} = setup();
    run('API={hover:()=>new Promise(resolve=>window.resolveClick=resolve)}; startSelecting({x:400,y:200}); onMouseUp({})');
    run(cancel);
    run('window.resolveClick({ok:true,rect:{x:-650,y:200,width:300,height:400}})');
    await Promise.resolve(); await Promise.resolve();
    assert.equal(window.committed, undefined);
  });
}

test('failed press query falls back to current monitor', async () => {
  const {window,run} = setup();
  run('API={hover:()=>Promise.reject(new Error("unavailable"))}; startSelecting({x:400,y:200}); onMouseUp({})');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(window.committed.x, -1200);
  assert.equal(window.committed.width, 1200);
});

test('hover broadcasts across overlays and clears without replacing manual selections', () => {
  const first=setup(), second=setup();
  first.run('window.broadcasts=[]; API={broadcastSelection:(phase,rect,owner)=>window.broadcasts.push({phase,rect,owner})}; setHoverRect({x:-150,y:150,width:600,height:300},state.captureGeneration)');
  assert.equal(first.window.broadcasts.length, 1);
  second.run('state.monitor=1; state.originX=0; state.hoverGlobal=null; state.hoverLocal=null');
  second.run('onSelectionState('+JSON.stringify(first.window.broadcasts[0])+')');
  assert.equal(second.window.mask.x, 0);
  assert.equal(second.window.mask.width, 300);
  assert.equal(second.run('state.selection'), null);
  first.run('clearHover()');
  second.run('onSelectionState('+JSON.stringify(first.window.broadcasts.at(-1))+')');
  assert.equal(second.window.mask, null);
  second.run('state.selection={x:0,y:0,width:100,height:100}; state.phase="editing"');
  second.run('onSelectionState('+JSON.stringify(first.window.broadcasts[0])+')');
  assert.equal(second.run('state.selection.width'),100);
  assert.equal(second.run('state.phase'),'editing');
});

test('real masks carve the hover rectangle into four dimmed regions', () => {
  const {run}=setup();
  run('updateMask=window.realUpdateMask; dom.maskTop={style:{}}; dom.maskLeft={style:{}}; dom.maskRight={style:{}}; dom.maskBottom={style:{}}; render()');
  assert.equal(run('dom.maskTop.style.height'),'100px');
  assert.equal(run('dom.maskLeft.style.width'),'100px');
  assert.equal(run('dom.maskRight.style.left'),'300px');
  assert.equal(run('dom.maskBottom.style.top'),'300px');
});


test('mouse movement while a click query is pending does not discard the click', async () => {
  const {window,run}=setup();
  run('window.queries=[]; API={hover:()=>new Promise(resolve=>window.queries.push(resolve))}; startSelecting({x:400,y:200}); onMouseUp({}); requestHover({x:450,y:200}); flushHover(); window.queries[0]({ok:true,rect:{x:-650,y:200,width:300,height:400}})');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(window.committed.x,-650);
});

test('hover updates never interrupt another overlay manual drag', () => {
  const {run}=setup();
  run('startSelecting({x:120,y:120}); onMouseMove({clientX:180,clientY:200,buttons:1}); onSelectionState({phase:"selecting",owner:-3,rect:{x:0,y:0,width:50,height:50}})');
  assert.equal(run('state.selection.width'),90);
  assert.equal(run('state.drag.moved'),true);
});

test('an old overlay clear cannot erase a newer overlay hover', () => {
  const {run}=setup();
  run('state.monitor=2; onSelectionState({phase:"selecting",owner:-2,rect:{x:-900,y:100,width:200,height:200}}); onSelectionState({phase:"selecting",owner:-3,rect:{x:-800,y:100,width:200,height:200}}); onSelectionState({phase:"selecting",owner:-2,rect:null})');
  assert.equal(run('state.hoverGlobal.x'),-800);
});
