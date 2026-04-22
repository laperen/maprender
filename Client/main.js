// js/main.js — Entry point, wires up all modules
import { SceneManager } from './scene.js';
import { MapFetcher }   from './mapFetcher.js';
import { WorldBuilder } from './worldBuilder.js';
import { UIController } from './ui.js';
import { MiniMap }      from './minimap.js';
import { OverlayPanel, LeftPanel } from './overlay.js';

// ── Bootstrap ───────────────────────────────────────────────
const scene      = new SceneManager(document.getElementById('canvas-container'));
const fetcher    = new MapFetcher();
const builder    = new WorldBuilder(scene);
const minimap    = new MiniMap('map-preview-inner');
const ui         = new UIController({ scene, fetcher, builder, minimap });
const overlay    = new OverlayPanel({ uiController: ui });
const leftPanel  = new LeftPanel({ uiController: ui });

scene.start();
ui.init();
overlay.init();
leftPanel.init();

// Expose panels to ui so mode transitions update them
ui._overlay   = overlay;
ui._leftPanel = leftPanel;

// Cross-close: opening one panel closes the other
overlay._leftPanel  = leftPanel;
leftPanel._overlay  = overlay;
