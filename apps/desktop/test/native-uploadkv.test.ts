// iOS freeze: BHExport kv* (Documents/pending-uploads) as the upload KV + __BH_APP_INFO__; older shells keep IndexedDB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bhExportKV, nativeTransportOptions } from "../src/transport/native.ts";

function fakeExport(withKV: boolean) {
  const files = new Map<string, string>();
  const base = { share: async () => ({ completed: true }), saveToDocuments: async () => ({ path: "x" }) };
  if (!withKV) return { plugin: base, files };
  return {
    files,
    plugin: {
      ...base,
      kvGet: async ({ key }: { key: string }) => ({ value: files.has(key) ? files.get(key)! : null }),
      kvSet: async ({ key, value }: { key: string; value: string }) => void files.set(key, value),
      kvRemove: async ({ key }: { key: string }) => void files.delete(key),
      kvKeys: async ({ prefix = "" }: { prefix?: string }) => ({ keys: [...files.keys()].filter((k) => k.startsWith(prefix)) }),
    },
  };
}
const win = (plugin: object, info?: object) => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: (n: string) => n === "BHExport", Plugins: { BHExport: plugin } },
  fetch: globalThis.fetch,
  ...(info ? { __BH_APP_INFO__: info } : {}),
});

test("BHExport with kv*: uploadKV in Documents + app version/build (number build normalised)", async () => {
  const { plugin, files } = fakeExport(true);
  const o = nativeTransportOptions(win(plugin, { appVersion: "1.4", build: 1475 }));
  assert.ok(o.uploadKV); assert.equal(o.appVersion, "1.4"); assert.equal(o.build, "1475");
  await o.uploadKV!.set("uploads/index", "[]"); await o.uploadKV!.set("uploads/body/a", "{}");
  assert.equal(await o.uploadKV!.get("uploads/index"), "[]");
  assert.deepEqual((await o.uploadKV!.keys("uploads/body/")).sort(), ["uploads/body/a"]);
  await o.uploadKV!.remove("uploads/body/a");
  assert.equal(files.has("uploads/body/a"), false);
  assert.equal(await bhExportKV(plugin as Parameters<typeof bhExportKV>[0]).get("missing"), null);
});

test("older shell (BHExport without kv*, no __BH_APP_INFO__): no uploadKV (IndexedDB), no version override", () => {
  const { plugin } = fakeExport(false);
  const o = nativeTransportOptions(win(plugin));
  assert.ok(o.bhExport); assert.equal(o.uploadKV, undefined); assert.equal(o.appVersion, undefined); assert.equal(o.build, undefined);
});
