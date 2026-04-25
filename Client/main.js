// js/main.js — Entry point, wires up all modules
import { SceneManager } from './scene.js';
import { MapFetcher }   from './mapFetcher.js';
import { WorldBuilder } from './worldBuilder.js';
import { UIController } from './ui.js';

// ── Bootstrap ───────────────────────────────────────────────
const scene   = new SceneManager(document.getElementById('canvas-container'));
const fetcher = new MapFetcher();
const builder = new WorldBuilder(scene);
const ui      = new UIController({ scene, fetcher, builder });

scene.start();
ui.init();
