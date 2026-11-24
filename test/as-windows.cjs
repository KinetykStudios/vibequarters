// Test only: a program loaded with this (node --require) takes itself to run on Windows, so the parts that work only
// there are tested on every system.
if (process.platform !== "win32") Object.defineProperty(process, "platform", { value: "win32" });
