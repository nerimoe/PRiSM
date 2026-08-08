import { PrismDomainError } from "./errors";

export type ExternalIdentity = {
  provider: string;
  subject: string;
};

export function normalizeExternalIdentity(input: ExternalIdentity): ExternalIdentity {
  const provider = input.provider.trim().toLowerCase();
  const subject = input.subject.trim();

  if (!provider || !subject) {
    throw invalidExternalIdentity();
  }

  return { provider, subject };
}

export function parseIdentityKey(input: string): ExternalIdentity {
  const separatorIndex = input.indexOf(":");
  if (separatorIndex < 0) {
    throw invalidExternalIdentity();
  }

  return normalizeExternalIdentity({
    provider: input.slice(0, separatorIndex),
    subject: input.slice(separatorIndex + 1),
  });
}

export function externalIdentityKey(input: ExternalIdentity): string {
  const identity = normalizeExternalIdentity(input);
  return `${identity.provider}:${identity.subject}`;
}

function invalidExternalIdentity(): PrismDomainError {
  return new PrismDomainError(
    "External identity must include provider and subject.",
    "INVALID_EXTERNAL_IDENTITY",
  );
}
