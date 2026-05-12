import { state } from "./state.js";

const CALIBRATE_ENDPOINT = "http://localhost:8000/calibrate/";

let lastCalibrationOk = null;

function el(id) {
  return document.getElementById(id);
}

export function initCalibration() {
  const runBtn = el("calibrate-run-btn");
  const applyBtn = el("calibrate-apply-btn");
  const logEl = el("calibration-log");
  const jsonEl = el("calibration-json");
  const fileInput = el("calibration-image");

  if (!runBtn || !applyBtn || !logEl || !fileInput) return;

  applyBtn.addEventListener("click", () => {
    if (!lastCalibrationOk?.recommended) return;
    const r = lastCalibrationOk.recommended;
    el("gap-threshold").value = String(r.gap_threshold);
    el("min-line-height").value = String(r.min_line_height);
    el("padding").value = String(r.padding);
    el("min-line-height-floor").value = String(r.min_line_height_floor);
    logEl.textContent += `\n— Applied gap, min height, padding, floor to main form.`;
  });

  runBtn.addEventListener("click", async () => {
    const bounds = state.globalOutputs.bounds;
    if (!bounds) {
      alert("Set bounds crop first (same as mushaf).");
      return;
    }
    const f = fileInput.files?.[0];
    if (!f) {
      alert("Choose one sura-free reference image.");
      return;
    }

    lastCalibrationOk = null;
    applyBtn.disabled = true;
    logEl.textContent = "Running calibration…";
    if (jsonEl) jsonEl.textContent = "";
    runBtn.disabled = true;

    const fd = new FormData();
    fd.append("image", f);
    fd.append("crop_x", bounds.left);
    fd.append("crop_y", bounds.top);
    fd.append("crop_w", bounds.width);
    fd.append("crop_h", bounds.height);
    fd.append("expected_lines", el("expected-lines").value);
    fd.append("padding", el("padding").value);
    fd.append("min_line_height_floor", el("min-line-height-floor").value);
    fd.append("alternate_horizontal_margin", state.alternateHorizontalMargin);
    fd.append("nominal_height_margin_pct", el("cal-nominal-margin-pct").value);
    fd.append("verify_on_cropped_unclean", el("cal-verify-unclean").checked ? "1" : "0");

    try {
      const res = await fetch(CALIBRATE_ENDPOINT, { method: "POST", body: fd });
      const data = await res.json();
      if (Array.isArray(data.logs)) {
        logEl.textContent = data.logs.join("\n");
        if (data.log_file) {
          logEl.textContent += `\n\nLog file: ${data.log_file}`;
        }
        if (data.export_dir) {
          logEl.textContent += `\nExport folder: ${data.export_dir}`;
        }
      } else {
        logEl.textContent = JSON.stringify(data, null, 2);
      }
      if (jsonEl) {
        jsonEl.textContent = JSON.stringify(data, null, 2);
      }
      if (res.ok && data.status === "ok") {
        lastCalibrationOk = data;
        applyBtn.disabled = false;
      } else if (res.ok && data.status === "partial" && data.recommended) {
        lastCalibrationOk = data;
        applyBtn.disabled = false;
        logEl.textContent +=
          "\n\n— Status is PARTIAL: clean line count did not match N. You may still apply and tweak gap manually.";
      } else {
        lastCalibrationOk = null;
        applyBtn.disabled = true;
      }
    } catch (e) {
      logEl.textContent = String(e.message || e);
      applyBtn.disabled = true;
    } finally {
      runBtn.disabled = false;
    }
  });
}
