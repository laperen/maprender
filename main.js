// js/main.js — Entry point, wires up all modules
import { SceneManager } from './scene.js';
import { MapFetcher }   from './mapFetcher.js';
import { WorldBuilder } from './worldBuilder.js';
import { UIController } from './ui.js';
import { MiniMap }      from './minimap.js';

// ── Bootstrap ───────────────────────────────────────────────
const scene      = new SceneManager(document.getElementById('canvas-container'));
const fetcher    = new MapFetcher();
const builder    = new WorldBuilder(scene);
const minimap    = new MiniMap('map-preview-inner');
const ui         = new UIController({ scene, fetcher, builder, minimap });

scene.start();
ui.init();
