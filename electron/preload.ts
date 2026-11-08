// Sandboxed preload: exposes exactly four functions to the page and nothing else.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../src/shared/types';
import type { OpenFileKind, SaveFileRequest, SequenceScopeApi } from '../src/shared/types';

const api: SequenceScopeApi = {
  openFile: (kind: OpenFileKind) => ipcRenderer.invoke(IPC.openFile, kind) as ReturnType<SequenceScopeApi['openFile']>,
  saveFile: (request: SaveFileRequest) => ipcRenderer.invoke(IPC.saveFile, request) as ReturnType<SequenceScopeApi['saveFile']>,
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url) as ReturnType<SequenceScopeApi['openExternal']>,
  getAppInfo: () => ipcRenderer.invoke(IPC.getAppInfo) as ReturnType<SequenceScopeApi['getAppInfo']>,
};

contextBridge.exposeInMainWorld('sequenceScope', api);
