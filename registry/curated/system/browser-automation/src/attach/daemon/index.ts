/**
 * @fileoverview Barrel for the attach daemon lane (`./attach/daemon` subpath).
 * @module browser-automation/attach/daemon
 */
export * from './protocol.js';
export * from './daemon-lock.js';
export * from './daemon.js';
export * from './client.js';
export * from './surface.js';
export { main as daemonMain } from './daemon-main.js';
