// js/main.js — Entry point, wires up all modules
import { SceneManager } from './scene.js';
import { MapFetcher }   from './mapFetcher.js';
import { WorldBuilder } from './worldBuilder.js';
import { UIController } from './ui.js';
import { MiniMap }      from './minimap.js';
import { OverlayPanel } from './overlay.js';   // ← ADD THIS LINE

// ── Bootstrap ───────────────────────────────────────────────
const scene      = new SceneManager(document.getElementById('canvas-container'));
const fetcher    = new MapFetcher();
const builder    = new WorldBuilder(scene);
const minimap    = new MiniMap('map-preview-inner');
const ui         = new UIController({ scene, fetcher, builder, minimap });
const overlay    = new OverlayPanel({ uiController: ui });  // ← ADD THIS LINE

scene.start();
ui.init();
overlay.init();  // ← ADD THIS LINE

// Expose overlay to ui so mode transitions update it
ui._overlay = overlay;  // ← ADD THIS LINE
