import "./web.css";
import ratedPlayerSeasonsJson from "../data/processed/2016/rated_player_seasons.json?raw";
import { loadDraftPool } from "./draftClassic.js";
import { createClassicDraftApp } from "./webApp.js";

const root = document.querySelector<HTMLElement>("#app");

if (!root) {
  throw new Error("Missing #app root element.");
}

const pool = loadDraftPool(JSON.parse(ratedPlayerSeasonsJson) as unknown);
createClassicDraftApp({ root, pool });
