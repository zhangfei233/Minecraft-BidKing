import path from "node:path";
import { sendFile } from "../net/http.js";

export function createWikiModule({ rootDir, publicDir }) {
  const wikiDir = path.join(publicDir, "wiki");

  function handle(req, res, requestUrl) {
    if (requestUrl.pathname !== "/wiki") return false;
    sendFile(res, path.join(wikiDir, "index.html"));
    return true;
  }

  return { handle };
}
