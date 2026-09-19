import "./web.css";
import ratedPlayerSeasonsJson from "../data/processed/2016/rated_player_seasons.json?raw";
import { loadDraftPool } from "./draftClassic.js";
import { createClassicDraftApp } from "./webApp.js";

export function mountClassicDraft(root: HTMLElement): void {
  const pool = loadDraftPool(JSON.parse(ratedPlayerSeasonsJson) as unknown);
  createClassicDraftApp({ root, pool });
}

