if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = {};
}
if (typeof CSS.escape !== "function") {
  CSS.escape = (value: string) => value.replace(/([^\w-])/g, "\\$1");
}

// happy-dom does not implement `window.confirm`. Vitest 3 let `vi.spyOn` invent
// a missing property; Vitest 4 refuses with "can only spy on a function", so the
// environment has to supply a real one for the guard tests to replace. Declining
// is the safe default: no test calls it without stubbing a return value first.
if (typeof globalThis.confirm !== "function") {
  (globalThis as Record<string, unknown>).confirm = () => false;
}
// happy-dom's Storage is constructed per-window but the `localStorage` /
// `sessionStorage` accessors observed in this repo's vitest environment resolve
// to a shape without the Storage methods (`clear`/`getItem`/… are undefined),
// which fails dozens of suites at HEAD as well as here. Provide a minimal
// in-memory Web Storage implementation when the native one is unusable, so
// preference/persistence tests exercise real get/set/clear semantics.
for (const key of ["localStorage", "sessionStorage"] as const) {
  let usable = false;
  try {
    const store = globalThis[key] as Storage | undefined;
    usable =
      !!store &&
      typeof store.clear === "function" &&
      typeof store.getItem === "function" &&
      typeof store.setItem === "function" &&
      typeof store.removeItem === "function";
  } catch {
    usable = false;
  }
  if (usable) continue;
  const data = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return data.size;
    },
    clear: () => void data.clear(),
    getItem: (name: string) => (data.has(name) ? (data.get(name) as string) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (name: string) => void data.delete(name),
    setItem: (name: string, value: string) => void data.set(name, String(value)),
  };
  try {
    Object.defineProperty(globalThis, key, { value: stub, configurable: true, writable: true });
  } catch {
    // A non-configurable global we cannot replace: leave it as is.
  }
}
