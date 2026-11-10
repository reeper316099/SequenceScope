// Tauri bridge: gives the page the same `window.sequenceScope` object the Electron preload provides, but backed by
// Rust commands (src-tauri/src/commands.rs). Under Electron the preload already defines it, so this does nothing there.
// The UI code is unchanged: it keeps calling window.sequenceScope.openFile(...) etc.
import { invoke } from '@tauri-apps/api/core';
import { selectedBackend } from '../backend';
import type { AppInfo, CopyTextResult, OpenExternalResult, OpenFileKind, OpenFileResult, SaveFileRequest, SaveFileResult, SequenceScopeApi } from '../shared/types';

/** Turns an unexpected IPC failure (e.g. a denied permission) into the message string the UI shows. */
function failureMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The bridge: five functions, each forwarding to one Rust command. Rust validates every argument again. */
export const tauriApi: SequenceScopeApi = {
  openFile: (kind: OpenFileKind): Promise<OpenFileResult> =>
    invoke<OpenFileResult>('open_file', { kind }).catch((e: unknown): OpenFileResult => ({ ok: false, reason: 'read-error', message: failureMessage(e) })),
  saveFile: (request: SaveFileRequest): Promise<SaveFileResult> =>
    invoke<SaveFileResult>('save_file', { request }).catch((e: unknown): SaveFileResult => ({ ok: false, reason: 'write-error', message: failureMessage(e) })),
  openExternal: (url: string): Promise<OpenExternalResult> =>
    invoke<OpenExternalResult>('open_external', { url }).catch((e: unknown): OpenExternalResult => ({ ok: false, message: failureMessage(e) })),
  getAppInfo: (): Promise<AppInfo> => invoke<AppInfo>('get_app_info').then((a) => ({ ...a, electron: `${a.electron} (${selectedBackend()} backend)` })), // shown on the About page
  copyText: (text: string): Promise<CopyTextResult> =>
    invoke<CopyTextResult>('copy_text', { text }).catch((e: unknown): CopyTextResult => ({ ok: false, message: failureMessage(e) })),
};

/** Installs the Tauri bridge when running inside Tauri and no other bridge exists; in smoke mode also starts the self-check. */
export function installTauriBridge(): void {
  if (Reflect.has(window, 'sequenceScope') || !Reflect.has(window, '__TAURI_INTERNALS__')) return;
  window.sequenceScope = tauriApi;
  if (Reflect.has(window, '__SEQUENCESCOPE_SMOKE__')) void import('./smoke').then((m) => m.runSmokeCheck());
}
