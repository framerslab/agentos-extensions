/**
 * @fileoverview Barrel for the attach lane (`@framers/agentos-ext-browser-automation/attach`).
 *
 * Everything needed to embed or verify attach sessions: the controller, both
 * backends, the tool factory, structured errors, the DevToolsActivePort
 * parser, and the daemon lane. This file backs the package `exports` subpath
 * the wunderland e2e imports.
 *
 * @module browser-automation/attach
 */
export * from './attach/AttachController.js';
export * from './attach/backends/raw-cdp.js';
export * from './attach/backends/jxa.js';
export * from './attach/tools.js';
export * from './attach/errors.js';
export * from './attach/devtools-port.js';
export * from './attach/daemon/index.js';
