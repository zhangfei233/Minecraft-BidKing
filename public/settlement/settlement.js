import { WarehouseCanvas, loadClientItems } from "/common/warehouseCanvas.js";

const canvas = document.querySelector("#warehouseCanvas");
const tooltip = document.querySelector("#canvasTooltip");
const renderer = new WarehouseCanvas(canvas, { cellSize: 50 });
renderer.onValueChange = (value) => {
  document.querySelector("#revealedValue").textContent = formatNumber(value);
};
document.addEventListener("warehouse-image-loaded", () => renderer.render());
loadClientItems().then((items) => renderer.setItems(items));
bindCanvasTooltip(canvas, tooltip, renderer);

window.addEventListener("message", (event) => {
  if (event.data?.type === "warehouse_complete") renderer.animateFullWarehouse(event.data.items, 10000);
});

fetch("/api/test_warehouse")
  .then((response) => response.json())
  .then((data) => renderer.animateFullWarehouse(data.items, 10000));

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
