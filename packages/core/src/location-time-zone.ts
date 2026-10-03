import tzLookup from "@photostructure/tz-lookup";

/** Resolve the UI's IANA time zone from a WGS84 location, without network requests. */
export function resolveLocationTimeZone(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new RangeError("Invalid location coordinates.");
  }
  return tzLookup(latitude, longitude);
}
