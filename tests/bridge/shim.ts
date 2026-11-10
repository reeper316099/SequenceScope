// Runs INSIDE the page (added with addInitScript). It stands in for Tauri's `window.__TAURI_INTERNALS__`: calculation commands
// go to the Rust test bridge over HTTP (streamed: progress, then the result), the five native commands go to the Node side of the
// test (dialog doubles, see helpers.ts). Everything here must be self-contained: Playwright sends this function's source to the page.
export function pageShim(): void {
  const w = window as unknown as Record<string, unknown> & { __native(cmd: string, args: unknown): Promise<unknown> };
  const callbacks = new Map<number, (m: unknown) => void>();
  let nextId = 1;
  /** Real Tauri rejects with the command's error value; an Error carrying the same `code` and `message` is read the same way by the app. */
  const failure = (code: string, message: string): Error => Object.assign(new Error(message), { code });
  const NATIVE = ['open_file', 'save_file', 'open_external', 'get_app_info', 'copy_text'];
  w['__SEQUENCESCOPE_BACKEND__'] = 'rust';
  w['__TAURI_INTERNALS__'] = {
    transformCallback(cb: (m: unknown) => void, once?: boolean): number {
      const id = nextId++;
      callbacks.set(id, (m) => { if (once) callbacks.delete(id); cb(m); });
      return id;
    },
    unregisterCallback(id: number): void { callbacks.delete(id); },
    async invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
      if (NATIVE.includes(cmd)) return w.__native(cmd, args);
      const channelRef = Object.values(args).find((v): v is string => typeof v === 'string' && v.startsWith('__CHANNEL__:'));
      const channelId = channelRef === undefined ? null : Number(channelRef.slice('__CHANNEL__:'.length));
      const res = await fetch(`/invoke/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
      if (!res.ok || res.body === null) throw failure('unexpected', `bridge answered ${res.status}`);
      const reader = res.body.getReader();
      let leftover = new Uint8Array(0);
      const readExact = async (n: number): Promise<Uint8Array> => {
        const out = new Uint8Array(n);
        let got = 0;
        while (got < n) {
          if (leftover.length === 0) {
            const r = await reader.read();
            if (r.done) throw failure('unexpected', 'the bridge closed the reply early');
            leftover = r.value;
          }
          const take = Math.min(leftover.length, n - got);
          out.set(leftover.subarray(0, take), got);
          leftover = leftover.subarray(take);
          got += take;
        }
        return out;
      };
      const text = new TextDecoder();
      let index = 0;
      const deliver = (m: unknown): void => { if (channelId !== null) callbacks.get(channelId)?.(m); };
      for (;;) {
        const head = await readExact(5);
        const kind = String.fromCharCode(head[0] as number);
        const len = new DataView(head.buffer).getUint32(1, true);
        const payload = await readExact(len);
        if (kind === 'P') { deliver({ index: index++, message: JSON.parse(text.decode(payload)) as unknown }); continue; }
        deliver({ end: true, index });
        if (kind === 'J') return JSON.parse(text.decode(payload));
        if (kind === 'B') return payload.buffer;
        const e = JSON.parse(text.decode(payload)) as { code: string; message: string };
        throw failure(e.code, e.message);
      }
    },
  };
}
