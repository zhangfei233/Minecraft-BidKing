const listEl = document.querySelector("#instructionList");
const titleEl = document.querySelector("#instructionTitle");
const textEl = document.querySelector("#instructionText");

fetch("/instruction.json")
  .then((response) => response.json())
  .then((data) => renderInstructions(data))
  .catch(() => {
    titleEl.textContent = "加载失败";
    textEl.textContent = "无法读取 instruction.json。";
  });

function renderInstructions(data) {
  const entries = Object.entries(data || {});
  listEl.innerHTML = entries.map(([key], index) => `
    <li><button type="button" data-index="${index}">${escapeHtml(key)}</button></li>
  `).join("");
  const buttons = [...listEl.querySelectorAll("button")];
  buttons.forEach((button) => {
    button.addEventListener("click", () => selectEntry(entries, buttons, Number(button.dataset.index)));
  });
  if (entries.length) selectEntry(entries, buttons, 0);
}

function selectEntry(entries, buttons, index) {
  const [key, value] = entries[index] || ["", ""];
  buttons.forEach((button) => button.classList.toggle("is-active", Number(button.dataset.index) === index));
  titleEl.textContent = key;
  textEl.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
