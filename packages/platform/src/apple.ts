export const appClipBundleId = "moe.neri.hinatago.ArcadeLink";
export const fullAppBundleId = "moe.neri.hinatago";
export const androidPackageName = "moe.neri.hinatago";

export function appleAppSiteAssociation(teamId: string) {
  const appId = `${teamId}.${appClipBundleId}`;
  const fullAppId = `${teamId}.${fullAppBundleId}`;
  return {
    appclips: {
      apps: [appId],
    },
    applinks: {
      details: [
        {
          appIDs: [fullAppId],
          components: [{ "/": "/t/*/*" }],
        },
      ],
    },
    webcredentials: {
      apps: [fullAppId, appId],
    },
  };
}

export function appleAppSiteAssociationResponse(teamId: string): Response {
  return new Response(JSON.stringify(appleAppSiteAssociation(teamId)), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
    },
  });
}

export function androidCertificateFingerprints(value?: string): string[] {
  return Array.from(
    new Set(
      (value ?? "")
        .split(/[\s,]+/)
        .map((fingerprint) => fingerprint.replaceAll(":", "").toUpperCase())
        .filter((fingerprint) => /^[0-9A-F]{64}$/.test(fingerprint))
        .map((fingerprint) => fingerprint.match(/.{2}/g)?.join(":") ?? fingerprint),
    ),
  );
}

export function androidAssetLinks(certFingerprints?: string) {
  const fingerprints = androidCertificateFingerprints(certFingerprints);
  if (fingerprints.length === 0) return [];
  return [
    {
      relation: [
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: androidPackageName,
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ];
}

export function androidPasskeyOrigins(certFingerprints?: string): string[] {
  return androidCertificateFingerprints(certFingerprints).map((fingerprint) => {
    const bytes = fingerprint.split(":").map((value) => Number.parseInt(value, 16));
    const binary = String.fromCharCode(...bytes);
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return `android:apk-key-hash:${encoded}`;
  });
}

export function androidAssetLinksResponse(certFingerprints?: string): Response {
  return new Response(JSON.stringify(androidAssetLinks(certFingerprints)), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/json",
    },
  });
}
