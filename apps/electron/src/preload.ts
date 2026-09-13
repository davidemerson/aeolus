import { contextBridge, ipcRenderer } from 'electron';

// Synchronous on purpose: the value is needed before the renderer's first
// paint and the main process answers from memory.
const about = ipcRenderer.sendSync('aeolus:about') as { version: string; platform: string };

contextBridge.exposeInMainWorld('aeolus', about);
