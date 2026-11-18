import { assert, describe, it } from "vite-plus/test";

import { nextReaderZoom } from "./readerZoom";

describe("nextReaderZoom", () => {
  it("steps the 80 to 200 ladder and snaps an off-ladder level to the next stop", () => {
    const cases: Array<[number, "in" | "out" | "reset", number]> = [
      [100, "in", 110],
      [100, "out", 90],
      [200, "in", 200],
      [80, "out", 80],
      [105, "in", 110],
      [105, "out", 100],
      [150, "reset", 100],
    ];
    for (const [current, change, expected] of cases) {
      assert.strictEqual(nextReaderZoom(current, change), expected, `${current} ${change}`);
    }
  });
});
