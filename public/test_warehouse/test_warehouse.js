import { WarehouseCanvas, loadClientItems } from "/common/warehouseCanvas.js";

const canvas = document.querySelector("#warehouseCanvas");
const tooltip = document.querySelector("#canvasTooltip");
const renderer = new WarehouseCanvas(canvas, { cellSize: 54 });
const generateButton = document.querySelector("#generateButton");
const animateToggle = document.querySelector("#animateToggle");
const stats = document.querySelector("#stats");
const kInfo = document.querySelector("#kInfo");
const fixedK = readFixedK();

renderer.onValueChange = (value) => {
  document.querySelector("#revealedValue").textContent = formatNumber(value);
};

document.addEventListener("warehouse-image-loaded", () => renderer.render());
loadClientItems().then((items) => renderer.setItems(items));
bindCanvasTooltip(canvas, tooltip, renderer);
kInfo.textContent = `当前 k = ${fixedK}`;

generateButton.addEventListener("click", generate);
generate();

async function generate() {
  generateButton.disabled = true;
  try {
    const response = await fetch(`/api/test_warehouse?k=${encodeURIComponent(String(fixedK))}`);
    const data = await response.json();
    stats.textContent = JSON.stringify(
      {
        targetVolume: data.targetVolume,
        selectedCount: data.selectedCount,
        placedCount: data.placedCount,
        removedAfterPacking: data.removedAfterPacking,
        effectiveRows: data.effectiveRows,
      },
      null,
      2,
    );
    if (animateToggle.checked) await renderer.animateFullWarehouse(data.items, 10000);
    else renderer.loadFullWarehouse(data.items);
  } finally {
    generateButton.disabled = false;
  }
}

function readFixedK() {
  const raw = new URLSearchParams(location.search).get("k");
  const value = Number(raw);
  return Number.isFinite(value) ? value : 1;
}

function bindCanvasTooltip(canvas, tooltip, renderer) {
  canvas.addEventListener("mousemove", (event) => {
    const cell = renderer.cellFromEvent(event);
    const data = cell ? renderer.tooltipForCell(cell.x, cell.y) : null;
    if (!data) {
      tooltip.hidden = true;
      return;
    }
    tooltip.innerHTML = `
      <strong>${escapeHtml(data.name)}</strong>
      <span>${escapeHtml(data.typeLabel)}</span>
      <span>价值 ${formatNumber(data.price)}</span>
    `;
    tooltip.style.left = `${event.clientX + 14}px`;
    tooltip.style.top = `${event.clientY + 14}px`;
    tooltip.hidden = false;
  });
  canvas.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value || 0);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
