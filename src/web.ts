import "./web.css";
import draftPlayerSeasonsJson from "../data/processed/2016/draft_player_seasons.json?raw";
import { loadDraftPool } from "./draftClassic.js";
import { createClassicDraftApp } from "./webApp.js";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root element.");
}

const pool = loadDraftPool(JSON.parse(draftPlayerSeasonsJson) as unknown);
createClassicDraftApp({ root, pool });
