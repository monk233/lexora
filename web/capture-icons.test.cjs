const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(__dirname, name), "utf8");
const settingsKey = read("settings.js").match(/longshot:\s*\{[^}]*icon:\s*"([^"]+)"/)[1];
const captureKey = read("capture.js").match(/dom\.longshot\.insertAdjacentHTML\("afterbegin", LP\.skillIconSvg\("([^"]+)"\)\)/)[1];
assert.equal(captureKey, settingsKey);
assert.equal(captureKey, "scroll");
const button = read("capture.html").match(/<button[^>]*id="capture-longshot"[\s\S]*?<\/button>/)[0];
assert.ok(!button.includes("<svg"), "Long screenshot must use the shared icon");
assert.match(button, /data-action="longshot"/);
assert.match(button, /title="长截图"/);
assert.match(button, /<span class="label">长截图<\/span>/);
console.log("Capture and settings longshot icons share the scroll key.");
