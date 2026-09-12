import { describe, expect, it } from "vitest";
import { gcj02ToWgs84, outOfChina, wgs84ToGcj02 } from "./coord";

describe("coordinate transformation", () => {
  it("identifies points outside and inside China", () => {
    // Tokyo Station
    expect(outOfChina(35.681236, 139.767125)).toBe(true);
    // New York
    expect(outOfChina(40.7128, -74.006)).toBe(true);
    // Beijing
    expect(outOfChina(39.9042, 116.4074)).toBe(false);
    // Shanghai
    expect(outOfChina(31.2304, 121.4737)).toBe(false);
  });

  it("does not transform points outside China", () => {
    const tokyo: [number, number] = [35.681236, 139.767125];
    expect(wgs84ToGcj02(tokyo[0], tokyo[1])).toEqual(tokyo);
    expect(gcj02ToWgs84(tokyo[0], tokyo[1])).toEqual(tokyo);
  });

  it("transforms and round-trips coordinates inside China with high precision", () => {
    // Shanghai People's Square
    const wgsLat = 31.2304;
    const wgsLng = 121.4737;

    const [gcjLat, gcjLng] = wgs84ToGcj02(wgsLat, wgsLng);

    // GCJ-02 offset should be present (typically ~200-500 meters in Shanghai)
    expect(gcjLat).not.toBeCloseTo(wgsLat, 4);
    expect(gcjLng).not.toBeCloseTo(wgsLng, 4);

    // Inverse back to WGS-84 should match original down to 6 decimal places (~0.1m)
    const [backLat, backLng] = gcj02ToWgs84(gcjLat, gcjLng);
    expect(backLat).toBeCloseTo(wgsLat, 6);
    expect(backLng).toBeCloseTo(wgsLng, 6);
  });
});
