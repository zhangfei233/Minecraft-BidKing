import fs from "node:fs";
import path from "node:path";
import { parseCsvLine } from "../items/items.js";

export function loadDefinitions(rootDir, filename) {
  const csv = fs.readFileSync(path.join(rootDir, filename), "utf8").trim();
  const [headerLine, ...rows] = csv.split(/\r?\n/);
  const headers = parseCsvLine(headerLine);
  return new Map(
    rows.filter(Boolean).map((row) => {
      const cells = parseCsvLine(row);
      const definition = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
      return [definition.id, definition];
    }),
  );
}
